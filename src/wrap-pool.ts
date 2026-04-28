import createDebug from 'debug';
import type { Pool } from 'pg';
import { getWrappedClientDebugId, wrapClient } from './wrap-client.js';
import type { WrappedPool, WrappedPoolOptions } from './types.js';

const CONNECT_CALLBACK_UNSUPPORTED_MESSAGE =
  'connect(callback) is not supported by the wrapped pool; use the promise form';
const debug = createDebug('node-postgres-query-queue:pool');

export class WrappedPoolImpl implements WrappedPool {
  private readonly inner: Pool;
  private readonly wrapperOptions: WrappedPoolOptions;

  constructor(pool: Pool, options: WrappedPoolOptions = {}) {
    this.inner = pool;
    this.wrapperOptions = options;
  }

  async connect(...args: unknown[]): Promise<ReturnType<typeof wrapClient>> {
    if (args.length > 0 && typeof args[0] === 'function') {
      throw new Error(CONNECT_CALLBACK_UNSUPPORTED_MESSAGE);
    }

    debug('client acquire requested', this.poolDebugContext());
    const rawClient = await this.inner.connect();
    const client = wrapClient(rawClient, this.wrapperOptions);
    debug(getWrappedClientDebugId(client), 'client acquired', this.poolDebugContext());
    return client;
  }

  query: Pool['query'] = ((...args: unknown[]) => {
    debug('pool query', this.poolDebugContext());
    return (this.inner.query as (...queryArgs: unknown[]) => unknown)(...args);
  }) as Pool['query'];

  end: Pool['end'] = ((...args: unknown[]) => {
    debug('pool end requested', this.poolDebugContext());
    return (this.inner.end as (...endArgs: unknown[]) => unknown)(...args);
  }) as Pool['end'];

  private get emitter(): {
    on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    addListener(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    removeListener(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    removeAllListeners(event?: string | symbol): unknown;
    listeners(event: string | symbol): Function[];
    rawListeners(event: string | symbol): Function[];
    listenerCount(event: string | symbol, listener?: Function): number;
    setMaxListeners(n: number): unknown;
    getMaxListeners(): number;
    eventNames(): Array<string | symbol>;
    prependListener(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  } {
    return this.inner as unknown as WrappedPoolImpl['emitter'];
  }

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    return this.emitter.emit(event, ...args);
  }

  addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.emitter.addListener(event, listener);
    return this;
  }

  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.emitter.removeListener(event, listener);
    return this;
  }

  removeAllListeners(event?: string | symbol): this {
    this.emitter.removeAllListeners(event);
    return this;
  }

  listeners(event: string | symbol): Function[] {
    return this.emitter.listeners(event);
  }

  rawListeners(event: string | symbol): Function[] {
    return this.emitter.rawListeners(event);
  }

  listenerCount(event: string | symbol, listener?: Function): number {
    if (listener === undefined) {
      return this.emitter.listenerCount(event);
    }

    return this.emitter.listenerCount(event, listener);
  }

  setMaxListeners(n: number): this {
    this.emitter.setMaxListeners(n);
    return this;
  }

  getMaxListeners(): number {
    return this.emitter.getMaxListeners();
  }

  eventNames(): Array<string | symbol> {
    return this.emitter.eventNames();
  }

  prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.emitter.prependListener(event, listener);
    return this;
  }

  prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    this.emitter.prependOnceListener(event, listener);
    return this;
  }

  get totalCount(): number {
    return this.inner.totalCount;
  }

  get idleCount(): number {
    return this.inner.idleCount;
  }

  get waitingCount(): number {
    return this.inner.waitingCount;
  }

  get expiredCount(): number {
    return this.inner.expiredCount;
  }

  get ending(): boolean {
    return this.inner.ending;
  }

  get ended(): boolean {
    return this.inner.ended;
  }

  get options(): Pool['options'] {
    return this.inner.options;
  }

  set options(options: Pool['options']) {
    this.inner.options = options;
  }

  private poolDebugContext(): Record<string, number | boolean> {
    return {
      totalCount: this.inner.totalCount,
      idleCount: this.inner.idleCount,
      waitingCount: this.inner.waitingCount,
      expiredCount: this.inner.expiredCount,
      ending: this.inner.ending,
      ended: this.inner.ended,
    };
  }
}

export function wrapPool(pool: Pool, options: WrappedPoolOptions = {}): WrappedPool {
  return new WrappedPoolImpl(pool, options);
}
