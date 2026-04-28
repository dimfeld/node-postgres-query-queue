import createDebug from 'debug';
import { getWrappedClientDebugId, wrapClient } from './wrap-client.js';
const CONNECT_CALLBACK_UNSUPPORTED_MESSAGE = 'connect(callback) is not supported by the wrapped pool; use the promise form';
const debug = createDebug('node-postgres-query-queue:pool');
export class WrappedPoolImpl {
    inner;
    wrapperOptions;
    constructor(pool, options = {}) {
        this.inner = pool;
        this.wrapperOptions = options;
    }
    async connect(...args) {
        if (args.length > 0 && typeof args[0] === 'function') {
            throw new Error(CONNECT_CALLBACK_UNSUPPORTED_MESSAGE);
        }
        debug('client acquire requested', this.poolDebugContext());
        const rawClient = await this.inner.connect();
        const client = wrapClient(rawClient, this.wrapperOptions);
        debug(getWrappedClientDebugId(client), 'client acquired', this.poolDebugContext());
        return client;
    }
    query = ((...args) => {
        debug('pool query', this.poolDebugContext());
        return this.inner.query(...args);
    });
    end = ((...args) => {
        debug('pool end requested', this.poolDebugContext());
        return this.inner.end(...args);
    });
    get emitter() {
        return this.inner;
    }
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return this;
    }
    emit(event, ...args) {
        return this.emitter.emit(event, ...args);
    }
    addListener(event, listener) {
        this.emitter.addListener(event, listener);
        return this;
    }
    removeListener(event, listener) {
        this.emitter.removeListener(event, listener);
        return this;
    }
    removeAllListeners(event) {
        this.emitter.removeAllListeners(event);
        return this;
    }
    listeners(event) {
        return this.emitter.listeners(event);
    }
    rawListeners(event) {
        return this.emitter.rawListeners(event);
    }
    listenerCount(event, listener) {
        if (listener === undefined) {
            return this.emitter.listenerCount(event);
        }
        return this.emitter.listenerCount(event, listener);
    }
    setMaxListeners(n) {
        this.emitter.setMaxListeners(n);
        return this;
    }
    getMaxListeners() {
        return this.emitter.getMaxListeners();
    }
    eventNames() {
        return this.emitter.eventNames();
    }
    prependListener(event, listener) {
        this.emitter.prependListener(event, listener);
        return this;
    }
    prependOnceListener(event, listener) {
        this.emitter.prependOnceListener(event, listener);
        return this;
    }
    get totalCount() {
        return this.inner.totalCount;
    }
    get idleCount() {
        return this.inner.idleCount;
    }
    get waitingCount() {
        return this.inner.waitingCount;
    }
    get expiredCount() {
        return this.inner.expiredCount;
    }
    get ending() {
        return this.inner.ending;
    }
    get ended() {
        return this.inner.ended;
    }
    get options() {
        return this.inner.options;
    }
    set options(options) {
        this.inner.options = options;
    }
    poolDebugContext() {
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
export function wrapPool(pool, options = {}) {
    return new WrappedPoolImpl(pool, options);
}
//# sourceMappingURL=wrap-pool.js.map