import { EventEmitter } from 'node:events';
import createDebug from 'debug';
import { ClientBrokenError, ClientReleasedError, DoubleReleaseError, ReleaseAbortedError, } from './errors.js';
import { normalizeQueryArgs } from './normalize-args.js';
import { FifoQueue, pump } from './queue.js';
function toError(value) {
    if (value instanceof Error) {
        return value;
    }
    return new Error(String(value));
}
const PG_QUERY_READ_TIMEOUT_MESSAGE = 'Query read timeout';
function isPgQueryReadTimeout(error) {
    const pgLikeError = error;
    return (error.message === PG_QUERY_READ_TIMEOUT_MESSAGE &&
        pgLikeError.code === undefined &&
        pgLikeError.severity === undefined);
}
function hasCallbackArg(args) {
    return typeof args.at(-1) === 'function';
}
function validateQueryInput(args) {
    if (args[0] === null || args[0] === undefined) {
        throw new TypeError('Client was passed a null or undefined query');
    }
}
function bindPassthrough(target, key) {
    const value = target[key];
    if (typeof value === 'function') {
        return value.bind(target);
    }
    return value;
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function asSubmittableErrorTarget(value) {
    return isObject(value) ? value : null;
}
const FORWARDED_RAW_EVENTS = ['notice', 'notification', 'end'];
const debug = createDebug('node-postgres-query-queue:client');
let nextDebugClientId = 1;
export class WrappedPoolClientImpl extends EventEmitter {
    raw;
    options;
    debugClientId;
    pumpState;
    onFatal;
    rawEventForwarders = new Map();
    lastNotifiedSnapshot;
    pumpScheduled = false;
    connect;
    copyFrom;
    copyTo;
    pauseDrain;
    resumeDrain;
    escapeIdentifier;
    escapeLiteral;
    setTypeParser;
    getTypeParser;
    ref;
    unref;
    constructor(rawClient, options = {}) {
        super();
        this.raw = rawClient;
        this.options = options;
        this.debugClientId = nextDebugClientId++;
        debug(this.debugClientId, 'wrapped client created', this.clientDebugContext());
        this.connect = bindPassthrough(rawClient, 'connect');
        this.copyFrom = bindPassthrough(rawClient, 'copyFrom');
        this.copyTo = bindPassthrough(rawClient, 'copyTo');
        this.pauseDrain = bindPassthrough(rawClient, 'pauseDrain');
        this.resumeDrain = bindPassthrough(rawClient, 'resumeDrain');
        this.escapeIdentifier = bindPassthrough(rawClient, 'escapeIdentifier');
        this.escapeLiteral = bindPassthrough(rawClient, 'escapeLiteral');
        this.setTypeParser = bindPassthrough(rawClient, 'setTypeParser');
        this.getTypeParser = bindPassthrough(rawClient, 'getTypeParser');
        this.ref = bindPassthrough(rawClient, 'ref');
        this.unref = bindPassthrough(rawClient, 'unref');
        this.pumpState = {
            raw: rawClient,
            active: false,
            activeItem: null,
            broken: false,
            releaseRequested: false,
            rawReleased: false,
            queue: new FifoQueue(),
            lastEmittedDrain: true,
        };
        this.onFatal = (error) => {
            const fatalError = toError(error);
            debug(this.debugClientId, 'fatal raw client error', fatalError);
            this.handleFatal(fatalError);
            if (this.listenerCount('error') > 0) {
                this.emit('error', fatalError);
            }
        };
        this.raw.on('error', this.onFatal);
        for (const event of FORWARDED_RAW_EVENTS) {
            const forward = (...args) => {
                debug(this.debugClientId, 'forwarding raw event', event);
                this.emit(event, ...args);
            };
            this.rawEventForwarders.set(event, forward);
            this.raw.on(event, forward);
        }
    }
    get processID() {
        return this.raw.processID;
    }
    get database() {
        return this.raw.database;
    }
    get host() {
        return this.raw.host;
    }
    get port() {
        return this.raw.port;
    }
    get user() {
        return this.raw.user;
    }
    get ssl() {
        return this.raw.ssl;
    }
    get queueSize() {
        return this.pumpState.queue.length;
    }
    get isReleased() {
        return this.pumpState.releaseRequested || this.pumpState.rawReleased;
    }
    query = ((...args) => {
        const callbackMode = hasCallbackArg(args);
        if (this.pumpState.broken) {
            const fatal = this.pumpState.releaseError;
            if (!(fatal instanceof Error)) {
                throw new Error('invariant: broken wrapper must have a stored fatal error');
            }
            const error = new ClientBrokenError(fatal);
            if (callbackMode) {
                throw error;
            }
            return Promise.reject(error);
        }
        if (this.pumpState.releaseRequested || this.pumpState.rawReleased) {
            const error = new ClientReleasedError();
            if (callbackMode) {
                throw error;
            }
            return Promise.reject(error);
        }
        validateQueryInput(args);
        const normalized = normalizeQueryArgs(args);
        if (normalized.kind === 'promise') {
            this.debugQueueingQuery(normalized.kind, normalized.description, args);
            return this.enqueuePromiseItem(normalized.dispatch, normalized.description, args);
        }
        if (normalized.kind === 'callback') {
            this.debugQueueingQuery(normalized.kind, normalized.description, args);
            return this.enqueueCallbackItem(normalized.dispatchArgs, normalized.userCallback, normalized.description, args);
        }
        this.debugQueueingQuery(normalized.kind, normalized.description, args);
        return this.enqueueSubmittableItem(normalized.dispatch, normalized.description, args[0], args);
    });
    release(err) {
        if (this.pumpState.rawReleased || this.pumpState.releaseRequested) {
            debug(this.debugClientId, 'double release attempted');
            throw new DoubleReleaseError();
        }
        this.pumpState.releaseRequested = true;
        debug(this.debugClientId, 'release requested', {
            withError: err !== undefined,
            queueSize: this.pumpState.queue.length,
            running: this.pumpState.active,
        });
        if (err instanceof Error || err === true) {
            this.pumpState.releaseError = err;
            const shouldAbortQueued = this.options.abortQueuedQueriesOnReleaseError !== false;
            if (shouldAbortQueued) {
                debug(this.debugClientId, 'aborting queued queries before release', {
                    queued: this.pumpState.queue.length,
                    active: this.pumpState.activeItem !== null,
                });
                const releaseAborted = new ReleaseAbortedError(err);
                const queuedItems = this.pumpState.queue.drain();
                const activeItem = this.pumpState.activeItem;
                if (activeItem !== null) {
                    try {
                        activeItem.finalize(releaseAborted);
                    }
                    catch (error) {
                        this.deferCallbackThrow(error);
                    }
                }
                this.notifyStateChange();
                try {
                    this.doRawRelease(err);
                }
                finally {
                    this.finalizeItems(queuedItems, releaseAborted);
                    this.notifyStateChange();
                }
                return;
            }
        }
        else if (err !== undefined) {
            this.pumpState.releaseError = err;
        }
        this.notifyStateChange();
        this.schedulePump();
    }
    unwrap() {
        return this.raw;
    }
    queueSnapshot() {
        return {
            queued: this.pumpState.queue.length,
            running: this.pumpState.active,
            releaseRequested: this.pumpState.releaseRequested,
            broken: this.pumpState.broken,
        };
    }
    enqueuePromiseItem(dispatch, description, queryArgs = []) {
        const runArgs = [...queryArgs];
        return new Promise((resolve, reject) => {
            const item = {
                kind: 'promise',
                dispatch: (raw) => {
                    this.debugRunningQuery('promise', description, runArgs);
                    return dispatch(raw);
                },
                finalize: () => { },
                ...(description !== undefined ? { description } : {}),
            };
            item.finalize = this.createFinalize(item, (error, result) => {
                if (error !== null) {
                    reject(error);
                    return;
                }
                resolve(result);
            });
            this.pumpState.queue.push(item);
            this.pumpState.lastEmittedDrain = false;
            this.notifyStateChange();
            this.runPump();
        });
    }
    enqueueCallbackItem(dispatchArgs, userCallback, description, queryArgs = []) {
        let queryReturnValue;
        const submittedArgs = [...queryArgs];
        const runArgs = [...dispatchArgs];
        const item = {
            kind: 'callback',
            dispatch: (raw) => {
                this.debugRunningQuery('callback', description, runArgs, submittedArgs);
                const wrappedCallback = (error, result) => {
                    item.finalize(error === null ? null : toError(error), result);
                };
                queryReturnValue = raw.query(...dispatchArgs, wrappedCallback);
                return queryReturnValue;
            },
            finalize: () => { },
            ...(description !== undefined ? { description } : {}),
        };
        item.finalize = this.createFinalize(item, (error, result) => {
            userCallback(error, result);
        });
        this.pumpState.queue.push(item);
        this.pumpState.lastEmittedDrain = false;
        this.notifyStateChange();
        this.runPump();
        return queryReturnValue;
    }
    enqueueSubmittableItem(dispatch, description, immediateReturnValue, queryArgs) {
        const runArgs = [...queryArgs];
        const item = {
            kind: 'submittable',
            dispatch: (raw) => {
                this.debugRunningQuery('submittable', description, runArgs);
                return dispatch(raw);
            },
            finalize: () => { },
            ...(description !== undefined ? { description } : {}),
        };
        item.finalize = this.createFinalize(item, (error) => {
            const isActiveItem = this.pumpState.activeItem === item;
            if (error !== null && !isActiveItem) {
                this.notifyQueuedSubmittableError(immediateReturnValue, error);
            }
        });
        this.wrapSubmittableCallback(immediateReturnValue, queryArgs, item);
        this.pumpState.queue.push(item);
        this.pumpState.lastEmittedDrain = false;
        this.notifyStateChange();
        this.runPump();
        return immediateReturnValue;
    }
    createFinalize(item, settle) {
        let settled = false;
        return (error, result) => {
            if (settled) {
                return;
            }
            settled = true;
            debug(this.debugClientId, 'query finalized', {
                kind: item.kind,
                description: item.description,
                error,
            });
            try {
                settle(error, result);
            }
            finally {
                item.cleanup?.();
                const wasActive = this.pumpState.activeItem === item;
                if (wasActive && error !== null && isPgQueryReadTimeout(error)) {
                    this.breakClient(error, true);
                    return;
                }
                if (wasActive) {
                    this.pumpState.active = false;
                    this.pumpState.activeItem = null;
                }
                if (wasActive) {
                    this.notifyStateChange();
                    this.schedulePump();
                }
            }
        };
    }
    wrapSubmittableCallback(submittable, queryArgs, item) {
        const target = asSubmittableErrorTarget(submittable);
        if (target === null) {
            return;
        }
        const originalCallback = typeof target.callback === 'function'
            ? target.callback
            : queryArgs.findLast((arg) => {
                return typeof arg === 'function';
            });
        if (originalCallback === undefined) {
            return;
        }
        target.callback = (error, result) => {
            try {
                originalCallback(error, result);
            }
            finally {
                if (error !== null && error !== undefined) {
                    item.finalize(toError(error), result);
                }
            }
        };
    }
    notifyQueuedSubmittableError(submittable, error) {
        const target = asSubmittableErrorTarget(submittable);
        if (target === null) {
            return;
        }
        if (typeof target.handleError === 'function') {
            target.handleError(error, this.raw.connection);
            return;
        }
        target.callback?.(error);
    }
    schedulePump() {
        if (this.pumpScheduled) {
            return;
        }
        this.pumpScheduled = true;
        debug(this.debugClientId, 'pump scheduled');
        queueMicrotask(() => {
            this.pumpScheduled = false;
            this.runPump();
        });
    }
    runPump() {
        debug(this.debugClientId, 'pump run', this.queueSnapshot());
        pump(this.pumpState, {
            emitDrain: () => {
                if (this.options.emitDrain === false) {
                    return;
                }
                debug(this.debugClientId, 'drain emitted');
                this.emit('drain');
            },
            doRawRelease: (error) => {
                this.doRawRelease(error);
            },
            onStateChange: () => {
                this.notifyStateChange();
            },
            schedulePump: () => {
                this.schedulePump();
            },
        });
    }
    doRawRelease(error) {
        if (this.pumpState.rawReleased) {
            return;
        }
        debug(this.debugClientId, 'raw client release', {
            withError: error !== undefined,
            queueSize: this.pumpState.queue.length,
            running: this.pumpState.active,
        });
        this.pumpState.rawReleased = true;
        this.raw.off('error', this.onFatal);
        for (const [event, forward] of this.rawEventForwarders) {
            this.raw.off(event, forward);
        }
        this.rawEventForwarders.clear();
        if (error !== undefined) {
            this.raw.release(error);
        }
        else {
            this.raw.release();
        }
        this.notifyStateChange();
    }
    handleFatal(error) {
        this.breakClient(error, false);
    }
    breakClient(error, activeAlreadyFinalized) {
        if (this.pumpState.broken || this.pumpState.rawReleased) {
            return;
        }
        debug(this.debugClientId, 'breaking client', {
            error,
            activeAlreadyFinalized,
            queued: this.pumpState.queue.length,
        });
        this.pumpState.broken = true;
        this.pumpState.releaseError = error;
        const brokenError = new ClientBrokenError(error);
        if (activeAlreadyFinalized) {
            this.pumpState.active = false;
            this.pumpState.activeItem = null;
        }
        else if (this.pumpState.activeItem !== null) {
            try {
                this.pumpState.activeItem.finalize(brokenError);
            }
            catch (error) {
                this.deferCallbackThrow(error);
            }
        }
        const queuedItems = this.pumpState.queue.drain();
        this.notifyStateChange();
        this.finalizeItems(queuedItems, brokenError);
        this.notifyStateChange();
        this.doRawRelease(error);
    }
    finalizeItems(items, error) {
        for (const item of items) {
            try {
                item.finalize(error);
            }
            catch (error) {
                this.deferCallbackThrow(error);
            }
        }
    }
    deferCallbackThrow(error) {
        queueMicrotask(() => {
            throw error;
        });
    }
    notifyStateChange() {
        const snapshot = this.queueSnapshot();
        debug(this.debugClientId, 'queue state changed', snapshot);
        const listener = this.options.onQueueStateChange;
        if (listener === undefined) {
            return;
        }
        if (this.lastNotifiedSnapshot !== undefined &&
            this.lastNotifiedSnapshot.queued === snapshot.queued &&
            this.lastNotifiedSnapshot.running === snapshot.running &&
            this.lastNotifiedSnapshot.releaseRequested === snapshot.releaseRequested &&
            this.lastNotifiedSnapshot.broken === snapshot.broken) {
            return;
        }
        this.lastNotifiedSnapshot = snapshot;
        try {
            listener(snapshot);
        }
        catch (error) {
            this.deferCallbackThrow(error);
        }
    }
    debugQueueingQuery(kind, description, args) {
        debug(this.debugClientId, 'query queued', {
            kind,
            description,
            args: [...args],
            queueSize: this.pumpState.queue.length + 1,
        });
    }
    debugRunningQuery(kind, description, args, submittedArgs) {
        debug(this.debugClientId, 'query running', {
            kind,
            description,
            args,
            ...(submittedArgs !== undefined ? { submittedArgs } : {}),
        });
    }
    clientDebugContext() {
        return {
            processID: this.processID,
            database: this.database,
            host: this.host,
            port: this.port,
            user: this.user,
        };
    }
}
export function wrapClient(rawClient, options = {}) {
    return new WrappedPoolClientImpl(rawClient, options);
}
export function getWrappedClientDebugId(client) {
    if (client instanceof WrappedPoolClientImpl) {
        return client.debugClientId;
    }
    return undefined;
}
//# sourceMappingURL=wrap-client.js.map