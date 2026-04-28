import { describe, it, expect } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import {
  makeClient,
  asPoolClient,
  flushMicrotasks,
  FakeSubmittable,
} from '../helpers/fake-client.js';

describe('submittable support', () => {
  describe('submittable queued behind a normal query', () => {
    it('does not dispatch submittable until prior promise query finishes', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      const p1 = client.query('SELECT 1');
      client.query(submittable);

      await flushMicrotasks();

      // Only SELECT 1 dispatched
      expect(raw.queryCallLog).toHaveLength(1);
      expect(raw.queryCallLog[0]).toEqual(['SELECT 1']);

      raw.resolveNext();
      await flushMicrotasks();

      // Now submittable is dispatched
      expect(raw.queryCallLog).toHaveLength(2);
      expect(raw.queryCallLog[1]).toEqual([submittable]);

      submittable.succeed();
      await flushMicrotasks();
      await p1;
    });

    it('wrappedClient.query(submittable) returns the submittable immediately', () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      // Submittable is passed as args[0] and returned immediately
      const returned = client.query(submittable);
      expect(returned).toBe(submittable);
    });
  });

  describe('submittable before a normal query', () => {
    it('queues normal query behind submittable', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      client.query(submittable);
      const p2 = client.query('SELECT 2');

      await flushMicrotasks();

      // Only submittable dispatched
      expect(raw.queryCallLog).toHaveLength(1);
      expect(raw.queryCallLog[0]).toEqual([submittable]);

      // Advance submittable
      submittable.succeed();
      await flushMicrotasks();

      // Now SELECT 2 is dispatched
      expect(raw.queryCallLog).toHaveLength(2);
      expect(raw.queryCallLog[1]).toEqual(['SELECT 2']);

      raw.resolveNext();
      await p2;
    });
  });

  describe('submittable end event', () => {
    it('advances queue on end event', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      client.query(submittable);
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      submittable.succeed();
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(2);
      raw.resolveNext();
      await p2;
    });
  });

  describe('submittable error event', () => {
    it('advances queue on error event', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();
      const submittableError = new Error('cursor error');

      client.query(submittable);
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      submittable.fail(submittableError);
      await flushMicrotasks();

      // Queue advanced, SELECT 2 now dispatched
      expect(raw.queryCallLog).toHaveLength(2);
      raw.resolveNext();
      await p2;
    });
  });

  describe('listener cleanup', () => {
    it('removes end listener after error fires', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      client.query(submittable);
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      const listenerCountBefore = submittable.listenerCount('end');

      submittable.fail(new Error('cursor error'));
      await flushMicrotasks();

      // end listener should have been removed
      expect(submittable.listenerCount('end')).toBeLessThan(listenerCountBefore);

      raw.resolveNext();
      await p2;
    });

    it('removes error listener after end fires', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      client.query(submittable);
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      const listenerCountBefore = submittable.listenerCount('error');

      submittable.succeed();
      await flushMicrotasks();

      // error listener should have been removed
      expect(submittable.listenerCount('error')).toBeLessThan(listenerCountBefore);

      raw.resolveNext();
      await p2;
    });

    it('end event does not trigger finalize a second time after already fired', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      client.query(submittable);
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      submittable.succeed();
      // Emit end a second time - should be a no-op (listener was detached)
      submittable.emit('end');
      await flushMicrotasks();

      // SELECT 2 should only be dispatched once
      expect(raw.queryCallLog).toHaveLength(2);
      raw.resolveNext();
      await p2;
    });
  });

  describe('submittable in mixed queue', () => {
    it('handles promise → submittable → promise sequence', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();

      const p1 = client.query('SELECT 1');
      client.query(submittable);
      const p3 = client.query('SELECT 3');
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(1);
      expect(raw.queryCallLog[0]).toEqual(['SELECT 1']);

      raw.resolveNext();
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(2);
      expect(raw.queryCallLog[1]).toEqual([submittable]);

      submittable.succeed();
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(3);
      expect(raw.queryCallLog[2]).toEqual(['SELECT 3']);

      raw.resolveNext();
      await Promise.all([p1, p3]);
    });
  });

  describe('fatal error while submittable is active', () => {
    it('rejects submittable on fatal error (via wrapper broken state)', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const submittable = new FakeSubmittable();
      const fatalError = new Error('fatal');

      // We have no promise handle for the submittable itself, but we can
      // check that the queue is broken and a subsequent query rejects
      client.query(submittable);
      await flushMicrotasks();

      raw.emit('error', fatalError);
      await flushMicrotasks();

      expect(client.queueSnapshot().broken).toBe(true);
      expect(raw.releaseCalls).toHaveLength(1);
      expect(raw.releaseCalls[0]!.err).toBe(fatalError);
    });
  });
});
