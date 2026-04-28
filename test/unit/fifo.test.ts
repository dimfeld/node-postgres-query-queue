import { describe, it, expect } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import { makeClient, asPoolClient, flushMicrotasks } from '../helpers/fake-client.js';

describe('FIFO serialization', () => {
  it('dispatches first query immediately, queues second', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));

    const p1 = client.query('SELECT 1');
    const p2 = client.query('SELECT 2');

    await flushMicrotasks();

    // Only the first query should have been dispatched to the raw client
    expect(raw.queryCallLog).toHaveLength(1);
    expect(raw.queryCallLog[0]).toEqual(['SELECT 1']);

    raw.resolveNext();
    await flushMicrotasks();

    // Now the second query should be dispatched
    expect(raw.queryCallLog).toHaveLength(2);
    expect(raw.queryCallLog[1]).toEqual(['SELECT 2']);

    raw.resolveNext();
    await Promise.all([p1, p2]);
  });

  it('executes many queries in FIFO order', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const count = 10;

    const promises = Array.from({ length: count }, (_, i) => client.query(`SELECT ${i + 1}`));

    for (let i = 0; i < count; i++) {
      await flushMicrotasks();
      expect(raw.queryCallLog).toHaveLength(i + 1);
      expect(raw.queryCallLog[i]).toEqual([`SELECT ${i + 1}`]);
      raw.resolveNext();
    }

    await Promise.all(promises);
  });

  it('only one raw query is in-flight at a time', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));

    let maxConcurrent = 0;
    let current = 0;
    const origQuery = raw.query.bind(raw);
    raw.query = (...args: unknown[]): unknown => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      const result = origQuery(...args);
      if (result instanceof Promise) {
        return result.finally(() => current--);
      }
      return result;
    };

    const promises = Array.from({ length: 5 }, (_, i) => client.query(`SELECT ${i + 1}`));

    for (let i = 0; i < 5; i++) {
      await flushMicrotasks();
      raw.resolveNext();
    }

    await Promise.all(promises);
    expect(maxConcurrent).toBe(1);
  });

  it('two independent wrapped clients can run queries concurrently', async () => {
    const raw1 = makeClient();
    const raw2 = makeClient();
    const client1 = wrapClient(asPoolClient(raw1));
    const client2 = wrapClient(asPoolClient(raw2));

    const p1 = client1.query('SELECT 1');
    const p2 = client2.query('SELECT 2');

    await flushMicrotasks();

    // Both raw clients should have received their query simultaneously
    expect(raw1.queryCallLog).toHaveLength(1);
    expect(raw2.queryCallLog).toHaveLength(1);
    expect(raw1.queryCallLog[0]).toEqual(['SELECT 1']);
    expect(raw2.queryCallLog[0]).toEqual(['SELECT 2']);

    raw1.resolveNext();
    raw2.resolveNext();

    await Promise.all([p1, p2]);
  });

  it('second client queue does not affect first client queue', async () => {
    const raw1 = makeClient();
    const raw2 = makeClient();
    const client1 = wrapClient(asPoolClient(raw1));
    const client2 = wrapClient(asPoolClient(raw2));

    const p1a = client1.query('SELECT 1a');
    const p1b = client1.query('SELECT 1b');
    const p2a = client2.query('SELECT 2a');

    await flushMicrotasks();

    // client1 has one in-flight, client2 has one in-flight
    expect(raw1.queryCallLog).toHaveLength(1);
    expect(raw2.queryCallLog).toHaveLength(1);

    // Resolve client2 first - should not unblock client1's second query
    raw2.resolveNext();
    await flushMicrotasks();
    expect(raw1.queryCallLog).toHaveLength(1);

    // Resolve client1's first query
    raw1.resolveNext();
    await flushMicrotasks();
    expect(raw1.queryCallLog).toHaveLength(2);

    raw1.resolveNext();
    await Promise.all([p1a, p1b, p2a]);
  });

  it('queueSize reflects number of waiting queries', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));

    expect(client.queueSize).toBe(0);

    const p1 = client.query('SELECT 1');
    const p2 = client.query('SELECT 2');
    const p3 = client.query('SELECT 3');

    await flushMicrotasks();

    // p1 is active (not in queue), p2 and p3 are queued
    expect(client.queueSize).toBe(2);

    raw.resolveNext();
    await flushMicrotasks();

    expect(client.queueSize).toBe(1);

    raw.resolveNext();
    await flushMicrotasks();

    expect(client.queueSize).toBe(0);

    raw.resolveNext();
    await Promise.all([p1, p2, p3]);
  });

  it('queueSnapshot reflects current state', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));

    const snap0 = client.queueSnapshot();
    expect(snap0.queued).toBe(0);
    expect(snap0.running).toBe(false);
    expect(snap0.releaseRequested).toBe(false);
    expect(snap0.broken).toBe(false);

    const p1 = client.query('SELECT 1');
    client.query('SELECT 2');

    await flushMicrotasks();

    const snap1 = client.queueSnapshot();
    expect(snap1.queued).toBe(1);
    expect(snap1.running).toBe(true);

    raw.resolveNext();
    await flushMicrotasks();

    raw.resolveNext();
    await p1;
  });
});
