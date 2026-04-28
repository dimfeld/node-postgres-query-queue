import type { Pool } from 'pg';
import { wrapClient } from './wrap-client.js';
import type { WrappedPool, WrappedPoolOptions } from './types.js';
export declare class WrappedPoolImpl implements WrappedPool {
    private readonly inner;
    private readonly wrapperOptions;
    constructor(pool: Pool, options?: WrappedPoolOptions);
    connect(...args: unknown[]): Promise<ReturnType<typeof wrapClient>>;
    query: Pool['query'];
    end: Pool['end'];
    private get emitter();
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    off(event: string | symbol, listener: (...args: unknown[]) => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    addListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    removeAllListeners(event?: string | symbol): this;
    listeners(event: string | symbol): Function[];
    rawListeners(event: string | symbol): Function[];
    listenerCount(event: string | symbol, listener?: Function): number;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
    eventNames(): Array<string | symbol>;
    prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    get totalCount(): number;
    get idleCount(): number;
    get waitingCount(): number;
    get expiredCount(): number;
    get ending(): boolean;
    get ended(): boolean;
    get options(): Pool['options'];
    set options(options: Pool['options']);
    private poolDebugContext;
}
export declare function wrapPool(pool: Pool, options?: WrappedPoolOptions): WrappedPool;
//# sourceMappingURL=wrap-pool.d.ts.map