import { describe, it, expect, vi } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import { ClientBrokenError } from '../../src/errors.js';
import { makeClient, asPoolClient, flushMicrotasks } from '../helpers/fake-client.js';

describe('error handling', () => {
  describe('single failed query does not block queue', () => {
    it('rejects the failed query but runs subsequent queries', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const queryError = new Error('query failed');

      const p1 = client.query('SELECT 1');
      void p1.catch(() => {}); // suppress unhandled rejection warning
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      raw.rejectNext(queryError);
      await flushMicrotasks();

      await expect(p1).rejects.toBe(queryError);

      // p2 should now be dispatched
      expect(raw.queryCallLog).toHaveLength(2);

      raw.resolveNext();
      await expect(p2).resolves.toBeDefined();
    });

    it('failed query advances queue with multiple subsequent queries', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const err1 = new Error('e1');
      const err2 = new Error('e2');
      const p1 = client.query('SELECT 1');
      void p1.catch(() => {});
      const p2 = client.query('SELECT 2');
      void p2.catch(() => {});
      const p3 = client.query('SELECT 3');
      await flushMicrotasks();

      raw.rejectNext(err1);
      await flushMicrotasks();
      raw.rejectNext(err2);
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      await expect(p1).rejects.toBe(err1);
      await expect(p2).rejects.toBe(err2);
      await expect(p3).resolves.toBeDefined();
    });
  });

  describe('fatal raw client error', () => {
    it('rejects active query with ClientBrokenError on fatal error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal connection error');

      const p1 = client.query('SELECT 1').catch((e: unknown) => e);
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      const result = await p1;
      expect(result).toBeInstanceOf(ClientBrokenError);
    });

    it('rejects all queued items with ClientBrokenError on fatal error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal connection error');

      // Attach .catch immediately to avoid unhandled rejection warnings when
      // handleFatal rejects all items synchronously
      const p1 = client.query('SELECT 1').catch((e: unknown) => e);
      const p2 = client.query('SELECT 2').catch((e: unknown) => e);
      const p3 = client.query('SELECT 3').catch((e: unknown) => e);
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBeInstanceOf(ClientBrokenError);
      expect(r2).toBeInstanceOf(ClientBrokenError);
      expect(r3).toBeInstanceOf(ClientBrokenError);
    });

    it('ClientBrokenError has the fatal error as cause', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('the cause');

      const p1 = client.query('SELECT 1').catch((e: unknown) => e);
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      const caught = await p1;
      expect(caught).toBeInstanceOf(ClientBrokenError);
      expect((caught as ClientBrokenError).cause).toBe(fatalError);
    });

    it('calls raw.release with fatal error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal');

      const p1 = client.query('SELECT 1').catch(() => {});
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);
      expect(raw.releaseCalls[0]!.err).toBe(fatalError);
      await p1;
    });

    it('calls raw.release exactly once even with multiple queued items', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal');

      // Catch immediately to avoid unhandled rejection warnings
      const p1 = client.query('SELECT 1').catch(() => {});
      const p2 = client.query('SELECT 2').catch(() => {});
      const p3 = client.query('SELECT 3').catch(() => {});
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);

      await Promise.all([p1, p2, p3]);
    });

    it('continues fatal cleanup when a queued callback throws', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal');
      const callbackError = new Error('callback failed');
      const deferredThrow = new Promise<unknown>((resolve) => {
        process.once('uncaughtException', resolve);
      });

      const p1 = client.query('SELECT 1');
      void p1.catch(() => {});
      client.query('SELECT 2', () => {
        throw callbackError;
      });
      const p3 = client.query('SELECT 3');
      void p3.catch(() => {});
      await flushMicrotasks();

      expect(() => raw.emit('error', fatalError)).not.toThrow();
      await flushMicrotasks();

      await expect(p1).rejects.toBeInstanceOf(ClientBrokenError);
      await expect(p3).rejects.toBeInstanceOf(ClientBrokenError);
      expect(raw.releaseCalls).toEqual([{ err: fatalError }]);
      await expect(deferredThrow).resolves.toBe(callbackError);
    });

    it('removes error listener from raw client after fatal error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal');

      // Install a no-op error handler to avoid EventEmitter unhandled-error crash
      raw.on('error', () => {});

      const p1 = client.query('SELECT 1').catch(() => {});
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      // After breakage, the wrapper's listener should be removed
      // A second error should not cause a double-release or double-rejection
      raw.emit('error', new Error('second fatal'));
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);
      await p1;
    });

    it('marks wrapper as broken after fatal error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal');

      const p1 = client.query('SELECT 1').catch(() => {});
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      expect(client.queueSnapshot().broken).toBe(true);
      await p1;
    });
  });

  describe('pg query_timeout handling', () => {
    it('treats an active pg query timeout as fatal and rejects queued work', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const timeoutError = new Error('Query read timeout');

      const active = client.query('SELECT pg_sleep(1)').catch((error) => error);
      const queued = client.query('SELECT 2').catch((error) => error);
      await flushMicrotasks();

      raw.rejectNext(timeoutError);
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(1);
      expect(raw.releaseCalls).toEqual([{ err: timeoutError }]);
      expect(client.queueSnapshot().broken).toBe(true);

      await expect(active).resolves.toBe(timeoutError);
      await expect(queued).resolves.toBeInstanceOf(ClientBrokenError);
      await expect(client.query('SELECT 3')).rejects.toBeInstanceOf(ClientBrokenError);
    });

    it('reports the original timeout to callback queries before breaking the client', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const timeoutError = new Error('Query read timeout');
      const callback = vi.fn();

      client.query('SELECT pg_sleep(1)', callback);
      const queued = client.query('SELECT 2').catch((error) => error);
      await flushMicrotasks();

      raw.rejectNext(timeoutError);
      await flushMicrotasks();

      expect(callback).toHaveBeenCalledWith(timeoutError, undefined);
      expect(raw.queryCallLog).toHaveLength(1);
      expect(raw.releaseCalls).toEqual([{ err: timeoutError }]);
      await expect(queued).resolves.toBeInstanceOf(ClientBrokenError);
    });

    it('does not treat server errors with the timeout message as fatal', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const serverError = Object.assign(new Error('Query read timeout'), {
        code: 'P0001',
        severity: 'ERROR',
      });

      const failed = client.query('SELECT 1').catch((error) => error);
      const next = client.query('SELECT 2');
      await flushMicrotasks();

      raw.rejectNext(serverError);
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(2);
      expect(raw.releaseCalls).toHaveLength(0);
      expect(client.queueSnapshot().broken).toBe(false);

      raw.resolveNext();
      await expect(failed).resolves.toBe(serverError);
      await expect(next).resolves.toBeDefined();
    });
  });

  describe('queries after breakage', () => {
    it('rejects promise-form query with ClientBrokenError', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal');

      const p1 = client.query('SELECT 1').catch(() => {});
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();
      await p1;

      await expect(client.query('SELECT 2')).rejects.toBeInstanceOf(ClientBrokenError);
    });

    it('throws synchronously on callback-form query after breakage', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const fatalError = new Error('fatal');

      const p1 = client.query('SELECT 1').catch(() => {});
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();
      await p1;

      expect(() => {
        client.query('SELECT 2', () => {});
      }).toThrow(ClientBrokenError);
    });
  });

  describe('re-entrant pump safety', () => {
    it('does not run pump after rawReleased', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      client.release();
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);

      // Any subsequent microtask pumps should be no-ops
      await flushMicrotasks();
      await flushMicrotasks();

      expect(raw.releaseCalls).toHaveLength(1);
    });
  });
});
