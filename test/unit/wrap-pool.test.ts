import { EventEmitter } from 'node:events';
import type { Pool, PoolOptions } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { wrapPool } from '../../src/wrap-pool.js';

class FakePool extends EventEmitter {
  totalCount = 3;
  idleCount = 2;
  waitingCount = 1;
  expiredCount = 4;
  ending = false;
  ended = false;
  options = {
    max: 10,
    maxUses: Infinity,
    allowExitOnIdle: false,
    maxLifetimeSeconds: 0,
    idleTimeoutMillis: 1000,
  } as PoolOptions;

  connect = vi.fn();
  query = vi.fn();
  end = vi.fn();
}

describe('wrapPool', () => {
  it('forwards pg Pool counters, state, and options', () => {
    const raw = new FakePool();
    const pool = wrapPool(raw as unknown as Pool);

    expect(pool.totalCount).toBe(3);
    expect(pool.idleCount).toBe(2);
    expect(pool.waitingCount).toBe(1);
    expect(pool.expiredCount).toBe(4);
    expect(pool.ending).toBe(false);
    expect(pool.ended).toBe(false);
    expect(pool.options).toBe(raw.options);

    const nextOptions = { ...raw.options, max: 20 };
    pool.options = nextOptions;

    expect(raw.options).toBe(nextOptions);
  });

  it('forwards additional EventEmitter methods to the raw pool', () => {
    const raw = new FakePool();
    const pool = wrapPool(raw as unknown as Pool);
    const first = vi.fn();
    const second = vi.fn();

    pool.on('connect', second);
    pool.prependListener('connect', first);

    expect(pool.rawListeners('connect')).toHaveLength(2);

    pool.emit('connect');

    expect(first).toHaveBeenCalledBefore(second);
  });
});
