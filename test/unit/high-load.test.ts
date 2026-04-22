import { describe, expect, it } from 'vitest';
import { ClientBrokenError, ReleaseAbortedError } from '../../src/errors.js';
import { FifoQueue } from '../../src/queue.js';
import { wrapClient } from '../../src/wrap-client.js';
import { asPoolClient, flushMicrotasks, makeClient } from '../helpers/fake-client.js';

describe('high-load queue behavior', () => {
  it('preserves FIFO order after many head-indexed shifts and drains', () => {
    const queue = new FifoQueue<number>();
    const total = 50_000;
    const shifted = 25_000;

    for (let i = 0; i < total; i += 1) {
      queue.push(i);
    }

    for (let i = 0; i < shifted; i += 1) {
      expect(queue.shift()).toBe(i);
    }

    expect(queue.length).toBe(total - shifted);
    expect(queue.drain()).toEqual(
      Array.from({ length: total - shifted }, (_, index) => index + shifted),
    );
    expect(queue.length).toBe(0);
  });

  it('bulk-aborts a large release-error backlog', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const queuedCount = 25_000;

    const active = client.query('SELECT active').catch((error) => error);
    const queued = Array.from({ length: queuedCount }, (_, index) =>
      client.query(`SELECT ${index}`),
    );
    const queuedErrors = queued.map((promise) => promise.catch((error) => error));

    await flushMicrotasks();

    const releaseError = new Error('release under load');
    client.release(releaseError);

    expect(client.queueSize).toBe(0);
    const errors = await Promise.all(queuedErrors);
    expect(errors).toHaveLength(queuedCount);
    expect(errors.every((error) => error instanceof ReleaseAbortedError)).toBe(true);

    await expect(active).resolves.toBeInstanceOf(ReleaseAbortedError);
    expect(raw.releaseCalls).toEqual([{ err: releaseError }]);
  });

  it('bulk-rejects a large fatal-error backlog', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const queuedCount = 25_000;

    const activeError = client.query('SELECT active').catch((error) => error);
    const queuedErrors = Array.from({ length: queuedCount }, (_, index) =>
      client.query(`SELECT ${index}`).catch((error) => error),
    );

    await flushMicrotasks();

    const fatalError = new Error('fatal under load');
    raw.emit('error', fatalError);

    expect(client.queueSize).toBe(0);
    const errors = await Promise.all([activeError, ...queuedErrors]);
    expect(errors).toHaveLength(queuedCount + 1);
    expect(errors.every((error) => error instanceof ClientBrokenError)).toBe(true);
    expect(raw.releaseCalls).toHaveLength(1);
    expect(raw.releaseCalls[0]!.err).toBe(fatalError);
  });
});
