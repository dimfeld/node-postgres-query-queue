import { describe, it, expect, vi } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import { ClientReleasedError } from '../../src/errors.js';
import { makeClient, asPoolClient, flushMicrotasks } from '../helpers/fake-client.js';

describe('callback API', () => {
  describe('callback ordering', () => {
    it('executes callback queries in FIFO order', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const order: number[] = [];

      const cb1 = vi.fn(() => order.push(1));
      const cb2 = vi.fn(() => order.push(2));

      client.query('SELECT 1', cb1);
      client.query('SELECT 2', cb2);

      await flushMicrotasks();
      expect(raw.queryCallLog).toHaveLength(1);

      raw.resolveNext();
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(2);

      raw.resolveNext();
      await flushMicrotasks();

      expect(order).toEqual([1, 2]);
    });

    it('mixes promise and callback queries preserving submission order', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const order: string[] = [];

      const p1 = client.query('SELECT 1').then(() => order.push('p1'));
      const cbDone = new Promise<void>((resolve) => {
        client.query('SELECT 2', () => {
          order.push('cb');
          resolve();
        });
      });
      const p3 = client.query('SELECT 3').then(() => order.push('p3'));

      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      await Promise.all([p1, cbDone, p3]);
      expect(order).toEqual(['p1', 'cb', 'p3']);
    });
  });

  describe('callback invoked exactly once', () => {
    it('calls callback once on success (text, cb)', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();

      client.query('SELECT 1', cb);
      await flushMicrotasks();
      raw.resolveNext({ rows: [{ val: 1 }] });
      await flushMicrotasks();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(null, expect.objectContaining({ rows: [{ val: 1 }] }));
    });

    it('calls callback once on success (text, values, cb)', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();

      client.query('SELECT $1', [42], cb);
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(null, expect.anything());
    });

    it('calls callback once on success (config, cb)', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();

      client.query({ text: 'SELECT 1' }, cb);
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(null, expect.anything());
    });

    it('calls callback once on success ({ text, callback })', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();

      const returnValue = client.query({ text: 'SELECT 1', callback: cb } as never);
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(returnValue).toBeUndefined();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(null, expect.anything());
    });

    it('calls callback once on success ({ text, callback }, values)', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();
      const values = [1];

      const returnValue = client.query({ text: 'SELECT $1', callback: cb } as never, values);
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(returnValue).toBeUndefined();
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(null, expect.anything());
    });

    it('calls callback once on failure', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();
      const queryError = new Error('query failed');

      client.query('SELECT 1', cb);
      await flushMicrotasks();
      raw.rejectNext(queryError);
      await flushMicrotasks();

      expect(cb).toHaveBeenCalledTimes(1);
      // pg callbacks are always called with (err, result) even on error
      expect(cb).toHaveBeenCalledWith(queryError, undefined);
    });

    it('does not call callback again on subsequent fatal error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();
      const queryError = new Error('query failed');

      client.query('SELECT 1', cb);
      await flushMicrotasks();

      // Reject the active item normally
      raw.rejectNext(queryError);
      await flushMicrotasks();

      // Simulate a fatal error after the query already settled
      raw.emit('error', new Error('fatal'));
      await flushMicrotasks();

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('callback advances queue', () => {
    it('failed callback query does not block the next queued query', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb1 = vi.fn();
      const p2 = new Promise<void>((resolve, reject) => {
        client.query('SELECT 1', cb1);
        client.query('SELECT 2').then(() => resolve(), reject);
      });

      await flushMicrotasks();
      raw.rejectNext(new Error('cb query failed'));
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(2);
      raw.resolveNext();
      await p2;
    });

    it('throwing callback does not block the next queued query', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const callbackError = new Error('callback failed');

      client.query('SELECT 1', () => {
        throw callbackError;
      });
      const p2 = client.query('SELECT 2');

      await flushMicrotasks();
      expect(() => raw.resolveNext()).toThrow(callbackError);
      await flushMicrotasks();

      expect(raw.queryCallLog).toHaveLength(2);
      raw.resolveNext();
      await expect(p2).resolves.toEqual(expect.anything());
    });
  });

  describe('callback after release', () => {
    it('throws synchronously when calling callback-style query after release', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));

      const p1 = client.query('SELECT 1');
      await flushMicrotasks();

      raw.resolveNext();
      await p1;

      client.release();
      await flushMicrotasks();

      expect(() => {
        client.query('SELECT 2', () => {});
      }).toThrow(ClientReleasedError);
    });
  });

  describe('raw client receives correct args', () => {
    it('strips callback from (text, cb) before dispatching', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();

      client.query('SELECT 1', cb);
      await flushMicrotasks();

      // The raw client should NOT have received the user callback
      // It should receive only the text (plus an internal finalize callback)
      const lastCall = raw.queryCallLog[0] as unknown[];
      expect(lastCall[0]).toBe('SELECT 1');
      // The second arg should be the internal finalize callback, not the user's callback
      expect(lastCall[1]).not.toBe(cb);
      expect(typeof lastCall[1]).toBe('function');

      raw.resolveNext();
      await flushMicrotasks();
    });

    it('strips callback from (text, values, cb) before dispatching', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();
      const values = [1];

      client.query('SELECT $1', values, cb);
      await flushMicrotasks();

      const lastCall = raw.queryCallLog[0] as unknown[];
      expect(lastCall[0]).toBe('SELECT $1');
      expect(lastCall[1]).toBe(values);
      expect(lastCall[2]).not.toBe(cb);
      expect(typeof lastCall[2]).toBe('function');

      raw.resolveNext();
      await flushMicrotasks();
    });

    it('strips callback from ({ text, callback }) before dispatching', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();

      client.query({ text: 'SELECT 1', values: [1], callback: cb } as never);
      await flushMicrotasks();

      const lastCall = raw.queryCallLog[0] as unknown[];
      expect(lastCall[0]).toEqual({ text: 'SELECT 1', values: [1] });
      expect(lastCall[0]).not.toHaveProperty('callback');
      expect(lastCall[1]).not.toBe(cb);
      expect(typeof lastCall[1]).toBe('function');

      raw.resolveNext();
      await flushMicrotasks();
    });

    it('strips callback from ({ text, callback }, values) before dispatching', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const cb = vi.fn();
      const values = [1];

      client.query({ text: 'SELECT $1', callback: cb } as never, values);
      await flushMicrotasks();

      const lastCall = raw.queryCallLog[0] as unknown[];
      expect(lastCall[0]).toEqual({ text: 'SELECT $1' });
      expect(lastCall[0]).not.toHaveProperty('callback');
      expect(lastCall[1]).toBe(values);
      expect(lastCall[2]).not.toBe(cb);
      expect(typeof lastCall[2]).toBe('function');

      raw.resolveNext();
      await flushMicrotasks();
    });
  });
});
