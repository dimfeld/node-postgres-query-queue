import { describe, it, expect } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import { ClientReleasedError, DoubleReleaseError, ReleaseAbortedError } from '../../src/errors.js';
import { makeClient, asPoolClient, flushMicrotasks } from '../helpers/fake-client.js';

describe('release semantics', () => {
  describe('release() while active query is in flight', () => {
    it('defers raw release until active query settles', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const p1 = client.query('SELECT 1');
      await flushMicrotasks();

      client.release();
      await flushMicrotasks();

      // Still waiting for the active query
      expect(raw.releaseCalls).toHaveLength(0);

      raw.resolveNext();
      await flushMicrotasks();

      // Now released
      expect(raw.releaseCalls).toHaveLength(1);
      expect(raw.releaseCalls[0]!.err).toBeUndefined();
      await p1;
    });

    it('defers raw release until all queued items drain', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const p1 = client.query('SELECT 1');
      const p2 = client.query('SELECT 2');
      const p3 = client.query('SELECT 3');
      await flushMicrotasks();

      client.release();
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(0);

      raw.resolveNext();
      await flushMicrotasks();
      expect(raw.releaseCalls).toHaveLength(0);

      raw.resolveNext();
      await flushMicrotasks();
      expect(raw.releaseCalls).toHaveLength(0);

      raw.resolveNext();
      await flushMicrotasks();
      expect(raw.releaseCalls).toHaveLength(1);

      await Promise.all([p1, p2, p3]);
    });

    it('does not accept new queries after release() is called', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const p1 = client.query('SELECT 1');
      await flushMicrotasks();

      client.release();

      await expect(client.query('SELECT 2')).rejects.toBeInstanceOf(ClientReleasedError);

      raw.resolveNext();
      await flushMicrotasks();
      await p1;
    });

    it('isReleased returns true after release() is called', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      expect(client.isReleased).toBe(false);
      client.release();
      expect(client.isReleased).toBe(true);

      await flushMicrotasks();
      expect(raw.releaseCalls).toHaveLength(1);
    });
  });

  describe('release() immediately when idle', () => {
    it('releases raw client immediately when no active or queued work', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      client.release();
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);
      expect(raw.releaseCalls[0]!.err).toBeUndefined();
    });
  });

  describe('release(err) with abortQueuedQueriesOnReleaseError: true (default)', () => {
    it('rejects queued items immediately with ReleaseAbortedError', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const releaseErr = new Error('release error');

      const p1 = client.query('SELECT 1'); // will be active
      void p1.catch(() => {}); // suppress unhandled rejection warning
      const p2 = client.query('SELECT 2'); // will be queued
      void p2.catch(() => {}); // suppress unhandled rejection warning
      const p3 = client.query('SELECT 3'); // will be queued
      void p3.catch(() => {}); // suppress unhandled rejection warning
      await flushMicrotasks();

      client.release(releaseErr);
      await flushMicrotasks();

      // Queued items rejected immediately
      await expect(p2).rejects.toBeInstanceOf(ReleaseAbortedError);
      await expect(p3).rejects.toBeInstanceOf(ReleaseAbortedError);

      await expect(p1).rejects.toBeInstanceOf(ReleaseAbortedError);
      expect(raw.releaseCalls).toEqual([{ err: releaseErr }]);
    });

    it('ReleaseAbortedError has original error as cause', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const releaseErr = new Error('the cause');

      const p1 = client.query('SELECT 1');
      void p1.catch(() => {});
      const p2 = client.query('SELECT 2');
      void p2.catch(() => {}); // suppress unhandled rejection warning
      await flushMicrotasks();

      client.release(releaseErr);

      const caughtError = await p2.catch((e: unknown) => e);
      expect(caughtError).toBeInstanceOf(ReleaseAbortedError);
      expect((caughtError as ReleaseAbortedError).cause).toBe(releaseErr);

      const activeError = await p1.catch((e: unknown) => e);
      expect(activeError).toBeInstanceOf(ReleaseAbortedError);
      expect((activeError as ReleaseAbortedError).cause).toBe(releaseErr);
    });

    it('continues aborting queued work when a queued callback throws', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const releaseErr = new Error('release error');
      const callbackErr = new Error('callback failed');
      const deferredThrow = new Promise<unknown>((resolve) => {
        process.once('uncaughtException', resolve);
      });

      const p1 = client.query('SELECT 1');
      void p1.catch(() => {});
      client.query('SELECT 2', () => {
        throw callbackErr;
      });
      const p3 = client.query('SELECT 3');
      void p3.catch(() => {});
      await flushMicrotasks();

      expect(() => client.release(releaseErr)).not.toThrow();
      await flushMicrotasks();

      await expect(p3).rejects.toBeInstanceOf(ReleaseAbortedError);
      expect(raw.releaseCalls).toEqual([{ err: releaseErr }]);
      await expect(p1).rejects.toBeInstanceOf(ReleaseAbortedError);
      await expect(deferredThrow).resolves.toBe(callbackErr);
    });
  });

  describe('release(true)', () => {
    it('aborts active and queued work and releases the raw client with true immediately', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const p1 = client.query('SELECT 1');
      void p1.catch(() => {});
      const p2 = client.query('SELECT 2');
      void p2.catch(() => {});
      const p3 = client.query('SELECT 3');
      void p3.catch(() => {});
      await flushMicrotasks();

      client.release(true);
      await flushMicrotasks();

      await expect(p2).rejects.toBeInstanceOf(ReleaseAbortedError);
      await expect(p3).rejects.toBeInstanceOf(ReleaseAbortedError);
      expect(raw.queryCallLog).toHaveLength(1);
      await expect(p1).rejects.toBeInstanceOf(ReleaseAbortedError);
      expect(raw.releaseCalls).toEqual([{ err: true }]);
    });

    it('uses true as the ReleaseAbortedError cause', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const p1 = client.query('SELECT 1');
      void p1.catch(() => {});
      const p2 = client.query('SELECT 2');
      void p2.catch(() => {});
      await flushMicrotasks();

      client.release(true);

      const caughtError = await p2.catch((e: unknown) => e);
      expect(caughtError).toBeInstanceOf(ReleaseAbortedError);
      expect((caughtError as ReleaseAbortedError).cause).toBe(true);

      const activeError = await p1.catch((e: unknown) => e);
      expect(activeError).toBeInstanceOf(ReleaseAbortedError);
      expect((activeError as ReleaseAbortedError).cause).toBe(true);
    });
  });

  describe('release(err) with abortQueuedQueriesOnReleaseError: false', () => {
    it('drains all queued items before releasing raw client with error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw), {
        abortQueuedQueriesOnReleaseError: false,
      });
      const releaseErr = new Error('release error');

      const p1 = client.query('SELECT 1');
      const p2 = client.query('SELECT 2');
      const p3 = client.query('SELECT 3');
      await flushMicrotasks();

      client.release(releaseErr);
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(0);

      raw.resolveNext();
      await flushMicrotasks();
      expect(raw.releaseCalls).toHaveLength(0);

      raw.resolveNext();
      await flushMicrotasks();
      expect(raw.releaseCalls).toHaveLength(0);

      raw.resolveNext();
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);
      expect(raw.releaseCalls[0]!.err).toBe(releaseErr);

      await Promise.all([p1, p2, p3]);
    });
  });

  describe('double release', () => {
    it('throws DoubleReleaseError on second release() call', () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      client.release();

      expect(() => client.release()).toThrow(DoubleReleaseError);
    });

    it('throws DoubleReleaseError when calling release() after release(err)', () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      client.release(new Error('first release'));

      expect(() => client.release()).toThrow(DoubleReleaseError);
    });
  });

  describe('raw client released exactly once', () => {
    it('raw.release is called exactly once even with queued work', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const p1 = client.query('SELECT 1');
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      client.release();
      raw.resolveNext();
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);
      await Promise.all([p1, p2]);
    });
  });

  describe('post-release query rejection', () => {
    it('promise-form query after release() rejects with ClientReleasedError', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      client.release();
      await flushMicrotasks();

      await expect(client.query('SELECT 1')).rejects.toBeInstanceOf(ClientReleasedError);
    });

    it('callback-form query after release() throws synchronously', () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      client.release();

      expect(() => {
        client.query('SELECT 1', () => {});
      }).toThrow(ClientReleasedError);
    });

    it('onQueueStateChange reports releaseRequested=true after release()', async () => {
      const raw = makeClient();
      const snapshots: import('../../src/types.js').QueueSnapshot[] = [];
      const client = wrapClient(asPoolClient(raw), {
        onQueueStateChange: (s) => snapshots.push(s),
      });

      client.release();
      await flushMicrotasks();

      const releasedSnap = snapshots.find((s) => s.releaseRequested);
      expect(releasedSnap).toBeDefined();
    });
  });
});
