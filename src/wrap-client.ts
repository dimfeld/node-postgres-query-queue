import { EventEmitter } from 'node:events';
import createDebug from 'debug';
import type { PoolClient, QueryResult } from 'pg';
import {
  ClientBrokenError,
  ClientReleasedError,
  DoubleReleaseError,
  ReleaseAbortedError,
} from './errors.js';
import { normalizeQueryArgs } from './normalize-args.js';
import { FifoQueue, pump, type PumpState, type QueueItem } from './queue.js';
import type { QueueSnapshot, WrappedPoolClient, WrappedPoolOptions } from './types.js';

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(String(value));
}

const PG_QUERY_READ_TIMEOUT_MESSAGE = 'Query read timeout';

function isPgQueryReadTimeout(error: Error): boolean {
  const pgLikeError = error as { code?: unknown; severity?: unknown };
  return (
    error.message === PG_QUERY_READ_TIMEOUT_MESSAGE &&
    pgLikeError.code === undefined &&
    pgLikeError.severity === undefined
  );
}

function hasCallbackArg(args: unknown[]): boolean {
  return typeof args.at(-1) === 'function';
}

function validateQueryInput(args: unknown[]): void {
  if (args[0] === null || args[0] === undefined) {
    throw new TypeError('Client was passed a null or undefined query');
  }
}

function bindPassthrough<T>(target: object, key: PropertyKey): T {
  const value = (target as Record<PropertyKey, unknown>)[key];
  if (typeof value === 'function') {
    return value.bind(target) as T;
  }

  return value as T;
}

interface SubmittableErrorTarget {
  callback?: (error: Error | null, result?: unknown) => void;
  handleError?: (error: Error, connection?: unknown) => void;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function asSubmittableErrorTarget(value: unknown): SubmittableErrorTarget | null {
  return isObject(value) ? (value as SubmittableErrorTarget) : null;
}

const FORWARDED_RAW_EVENTS = ['notice', 'notification', 'end'] as const;
const debug = createDebug('node-postgres-query-queue:client');
let nextDebugClientId = 1;

export class WrappedPoolClientImpl extends EventEmitter implements WrappedPoolClient {
  private readonly raw: PoolClient;
  private readonly options: WrappedPoolOptions;
  readonly debugClientId: number;
  private readonly pumpState: PumpState;
  private readonly onFatal: (error: unknown) => void;
  private readonly rawEventForwarders = new Map<string, (...args: unknown[]) => void>();
  private lastNotifiedSnapshot?: QueueSnapshot;
  private pumpScheduled = false;
  connect: PoolClient['connect'];
  copyFrom: PoolClient['copyFrom'];
  copyTo: PoolClient['copyTo'];
  pauseDrain: PoolClient['pauseDrain'];
  resumeDrain: PoolClient['resumeDrain'];
  escapeIdentifier: PoolClient['escapeIdentifier'];
  escapeLiteral: PoolClient['escapeLiteral'];
  setTypeParser: PoolClient['setTypeParser'];
  getTypeParser: PoolClient['getTypeParser'];
  ref: () => void;
  unref: () => void;

  constructor(rawClient: PoolClient, options: WrappedPoolOptions = {}) {
    super();
    this.raw = rawClient;
    this.options = options;
    this.debugClientId = nextDebugClientId++;
    debug(this.debugClientId, 'wrapped client created', this.clientDebugContext());
    this.connect = bindPassthrough<PoolClient['connect']>(rawClient, 'connect');
    this.copyFrom = bindPassthrough<PoolClient['copyFrom']>(rawClient, 'copyFrom');
    this.copyTo = bindPassthrough<PoolClient['copyTo']>(rawClient, 'copyTo');
    this.pauseDrain = bindPassthrough<PoolClient['pauseDrain']>(rawClient, 'pauseDrain');
    this.resumeDrain = bindPassthrough<PoolClient['resumeDrain']>(rawClient, 'resumeDrain');
    this.escapeIdentifier = bindPassthrough<PoolClient['escapeIdentifier']>(
      rawClient,
      'escapeIdentifier',
    );
    this.escapeLiteral = bindPassthrough<PoolClient['escapeLiteral']>(rawClient, 'escapeLiteral');
    this.setTypeParser = bindPassthrough<PoolClient['setTypeParser']>(rawClient, 'setTypeParser');
    this.getTypeParser = bindPassthrough<PoolClient['getTypeParser']>(rawClient, 'getTypeParser');
    this.ref = bindPassthrough<() => void>(rawClient, 'ref');
    this.unref = bindPassthrough<() => void>(rawClient, 'unref');
    this.pumpState = {
      raw: rawClient,
      active: false,
      activeItem: null,
      broken: false,
      releaseRequested: false,
      rawReleased: false,
      queue: new FifoQueue<QueueItem>(),
      lastEmittedDrain: true,
    };

    this.onFatal = (error: unknown) => {
      const fatalError = toError(error);
      debug(this.debugClientId, 'fatal raw client error', fatalError);
      this.handleFatal(fatalError);

      if (this.listenerCount('error') > 0) {
        this.emit('error', fatalError);
      }
    };

    this.raw.on('error', this.onFatal);

    for (const event of FORWARDED_RAW_EVENTS) {
      const forward = (...args: unknown[]): void => {
        debug(this.debugClientId, 'forwarding raw event', event);
        this.emit(event, ...args);
      };
      this.rawEventForwarders.set(event, forward);
      this.raw.on(event, forward);
    }
  }

  get processID(): number | undefined {
    return (this.raw as { processID?: number }).processID;
  }

  get database(): string | undefined {
    return (this.raw as { database?: string }).database;
  }

  get host(): string | undefined {
    return (this.raw as { host?: string }).host;
  }

  get port(): number | undefined {
    return (this.raw as { port?: number }).port;
  }

  get user(): string | undefined {
    return (this.raw as { user?: string }).user;
  }

  get ssl(): unknown {
    return (this.raw as { ssl?: unknown }).ssl;
  }

  get queueSize(): number {
    return this.pumpState.queue.length;
  }

  get isReleased(): boolean {
    return this.pumpState.releaseRequested || this.pumpState.rawReleased;
  }

  query: PoolClient['query'] = ((...args: unknown[]) => {
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
      return this.enqueueCallbackItem(
        normalized.dispatchArgs,
        normalized.userCallback,
        normalized.description,
        args,
      );
    }

    this.debugQueueingQuery(normalized.kind, normalized.description, args);
    return this.enqueueSubmittableItem(normalized.dispatch, normalized.description, args[0], args);
  }) as PoolClient['query'];

  release(err?: Error | boolean): void {
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
          } catch (error) {
            this.deferCallbackThrow(error);
          }
        }

        this.notifyStateChange();
        try {
          this.doRawRelease(err);
        } finally {
          this.finalizeItems(queuedItems, releaseAborted);
          this.notifyStateChange();
        }
        return;
      }
    } else if (err !== undefined) {
      this.pumpState.releaseError = err;
    }

    this.notifyStateChange();
    this.schedulePump();
  }

  unwrap(): PoolClient {
    return this.raw;
  }

  queueSnapshot(): QueueSnapshot {
    return {
      queued: this.pumpState.queue.length,
      running: this.pumpState.active,
      releaseRequested: this.pumpState.releaseRequested,
      broken: this.pumpState.broken,
    };
  }

  private enqueuePromiseItem(
    dispatch: (raw: PoolClient) => unknown,
    description?: string,
    queryArgs: unknown[] = [],
  ): Promise<unknown> {
    const runArgs = [...queryArgs];
    return new Promise<unknown>((resolve, reject) => {
      const item: QueueItem = {
        kind: 'promise',
        dispatch: (raw: PoolClient) => {
          this.debugRunningQuery('promise', description, runArgs);
          return dispatch(raw);
        },
        finalize: () => {},
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

  private enqueueCallbackItem(
    dispatchArgs: unknown[],
    userCallback: (error: Error | null, result?: QueryResult) => void,
    description?: string,
    queryArgs: unknown[] = [],
  ): unknown {
    let queryReturnValue: unknown;
    const submittedArgs = [...queryArgs];
    const runArgs = [...dispatchArgs];

    const item: QueueItem = {
      kind: 'callback',
      dispatch: (raw: PoolClient) => {
        this.debugRunningQuery('callback', description, runArgs, submittedArgs);
        const wrappedCallback = (error: unknown, result?: unknown): void => {
          item.finalize(error === null ? null : toError(error), result);
        };
        queryReturnValue = (raw.query as (...rawArgs: unknown[]) => unknown)(
          ...dispatchArgs,
          wrappedCallback,
        );
        return queryReturnValue;
      },
      finalize: () => {},
      ...(description !== undefined ? { description } : {}),
    };
    item.finalize = this.createFinalize(item, (error, result) => {
      userCallback(error, result as QueryResult | undefined);
    });

    this.pumpState.queue.push(item);
    this.pumpState.lastEmittedDrain = false;
    this.notifyStateChange();
    this.runPump();

    return queryReturnValue;
  }

  private enqueueSubmittableItem(
    dispatch: (raw: PoolClient) => unknown,
    description: string | undefined,
    immediateReturnValue: unknown,
    queryArgs: unknown[],
  ): unknown {
    const runArgs = [...queryArgs];
    const item: QueueItem = {
      kind: 'submittable',
      dispatch: (raw: PoolClient) => {
        this.debugRunningQuery('submittable', description, runArgs);
        return dispatch(raw);
      },
      finalize: () => {},
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

  private createFinalize(
    item: QueueItem,
    settle: (error: Error | null, result?: unknown) => void,
  ): (error: Error | null, result?: unknown) => void {
    let settled = false;

    return (error: Error | null, result?: unknown): void => {
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
      } finally {
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

  private wrapSubmittableCallback(
    submittable: unknown,
    queryArgs: unknown[],
    item: QueueItem,
  ): void {
    const target = asSubmittableErrorTarget(submittable);
    if (target === null) {
      return;
    }

    const originalCallback =
      typeof target.callback === 'function'
        ? target.callback
        : queryArgs.findLast((arg): arg is (error: Error | null, result?: unknown) => void => {
            return typeof arg === 'function';
          });

    if (originalCallback === undefined) {
      return;
    }

    target.callback = (error: Error | null, result?: unknown): void => {
      try {
        originalCallback(error, result);
      } finally {
        if (error !== null && error !== undefined) {
          item.finalize(toError(error), result);
        }
      }
    };
  }

  private notifyQueuedSubmittableError(submittable: unknown, error: Error): void {
    const target = asSubmittableErrorTarget(submittable);
    if (target === null) {
      return;
    }

    if (typeof target.handleError === 'function') {
      target.handleError(error, (this.raw as { connection?: unknown }).connection);
      return;
    }

    target.callback?.(error);
  }

  private schedulePump(): void {
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

  private runPump(): void {
    debug(this.debugClientId, 'pump run', this.queueSnapshot());
    pump(this.pumpState, {
      emitDrain: () => {
        if (this.options.emitDrain === false) {
          return;
        }

        debug(this.debugClientId, 'drain emitted');
        this.emit('drain');
      },
      doRawRelease: (error?: Error | boolean) => {
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

  private doRawRelease(error?: Error | boolean): void {
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
    } else {
      this.raw.release();
    }

    this.notifyStateChange();
  }

  private handleFatal(error: Error): void {
    this.breakClient(error, false);
  }

  private breakClient(error: Error, activeAlreadyFinalized: boolean): void {
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
    } else if (this.pumpState.activeItem !== null) {
      try {
        this.pumpState.activeItem.finalize(brokenError);
      } catch (error) {
        this.deferCallbackThrow(error);
      }
    }

    const queuedItems = this.pumpState.queue.drain();
    this.notifyStateChange();
    this.finalizeItems(queuedItems, brokenError);

    this.notifyStateChange();
    this.doRawRelease(error);
  }

  private finalizeItems(items: QueueItem[], error: Error): void {
    for (const item of items) {
      try {
        item.finalize(error);
      } catch (error) {
        this.deferCallbackThrow(error);
      }
    }
  }

  private deferCallbackThrow(error: unknown): void {
    queueMicrotask(() => {
      throw error;
    });
  }

  private notifyStateChange(): void {
    const snapshot = this.queueSnapshot();
    debug(this.debugClientId, 'queue state changed', snapshot);

    const listener = this.options.onQueueStateChange;
    if (listener === undefined) {
      return;
    }

    if (
      this.lastNotifiedSnapshot !== undefined &&
      this.lastNotifiedSnapshot.queued === snapshot.queued &&
      this.lastNotifiedSnapshot.running === snapshot.running &&
      this.lastNotifiedSnapshot.releaseRequested === snapshot.releaseRequested &&
      this.lastNotifiedSnapshot.broken === snapshot.broken
    ) {
      return;
    }

    this.lastNotifiedSnapshot = snapshot;
    try {
      listener(snapshot);
    } catch (error) {
      this.deferCallbackThrow(error);
    }
  }

  private debugQueueingQuery(
    kind: QueueItem['kind'],
    description: string | undefined,
    args: unknown[],
  ): void {
    if (debug.enabled) {
      debug(this.debugClientId, 'query queued', {
        kind,
        description,
        args: [...args],
        queueSize: this.pumpState.queue.length + 1,
      });
    }
  }

  private debugRunningQuery(
    kind: QueueItem['kind'],
    description: string | undefined,
    args: unknown[],
    submittedArgs?: unknown[],
  ): void {
    debug(this.debugClientId, 'query running', {
      kind,
      description,
      args,
      submittedArgs,
    });
  }

  private clientDebugContext(): Record<string, unknown> {
    return {
      processID: this.processID,
      database: this.database,
      host: this.host,
      port: this.port,
      user: this.user,
    };
  }
}

export function wrapClient(
  rawClient: PoolClient,
  options: WrappedPoolOptions = {},
): WrappedPoolClient {
  return new WrappedPoolClientImpl(rawClient, options);
}

export function getWrappedClientDebugId(client: WrappedPoolClient): number | undefined {
  if (client instanceof WrappedPoolClientImpl) {
    return client.debugClientId;
  }

  return undefined;
}
