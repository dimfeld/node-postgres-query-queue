import type { PoolClient } from 'pg';

export type QueueItemKind = 'promise' | 'callback' | 'submittable';

interface EventEmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): EventEmitterLike;
  off(event: string, listener: (...args: unknown[]) => void): EventEmitterLike;
  once(event: string, listener: (...args: unknown[]) => void): EventEmitterLike;
}

export interface QueueItem {
  kind: QueueItemKind;
  dispatch: (raw: PoolClient) => unknown;
  finalize: (err: Error | null, result?: unknown) => void;
  cleanup?: () => void;
  description?: string;
}

export class FifoQueue<T> {
  private items: Array<T | undefined> = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) {
      return undefined;
    }

    const item = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;

    if (this.head > 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }

    return item;
  }

  drain(): T[] {
    if (this.length === 0) {
      this.items = [];
      this.head = 0;
      return [];
    }

    const drained = this.items.slice(this.head) as T[];
    this.items = [];
    this.head = 0;
    return drained;
  }
}

export interface PumpState {
  raw: PoolClient;
  active: boolean;
  activeItem: QueueItem | null;
  broken: boolean;
  releaseRequested: boolean;
  releaseError?: Error | boolean;
  rawReleased: boolean;
  queue: FifoQueue<QueueItem>;
  lastEmittedDrain: boolean;
}

export interface PumpHooks {
  emitDrain: () => void;
  doRawRelease: (err?: Error | boolean) => void;
  onStateChange?: () => void;
  schedulePump: () => void;
}

function notifyStateChange(hooks: PumpHooks): void {
  hooks.onStateChange?.();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function isEventEmitterLike(value: unknown): value is EventEmitterLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'on' in value &&
    typeof value.on === 'function' &&
    'off' in value &&
    typeof value.off === 'function' &&
    'once' in value &&
    typeof value.once === 'function'
  );
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(String(value));
}

export function pump(state: PumpState, hooks: PumpHooks): void {
  if (state.broken || state.rawReleased || state.active) {
    return;
  }

  if (state.queue.length === 0) {
    if (state.releaseRequested) {
      hooks.doRawRelease(state.releaseError);
      return;
    }

    if (!state.lastEmittedDrain) {
      state.lastEmittedDrain = true;
      notifyStateChange(hooks);
      hooks.emitDrain();
    }

    return;
  }

  state.lastEmittedDrain = false;
  const item = state.queue.shift();
  if (item === undefined) {
    return;
  }

  state.active = true;
  state.activeItem = item;
  notifyStateChange(hooks);

  try {
    const dispatchResult = item.dispatch(state.raw);

    if (item.kind === 'callback') {
      return;
    }

    if (item.kind === 'promise') {
      if (!isPromiseLike(dispatchResult)) {
        item.finalize(new Error('Expected promise-like result from promise query dispatch'));
        return;
      }

      Promise.resolve(dispatchResult).then(
        (result) => item.finalize(null, result),
        (error: unknown) => item.finalize(toError(error)),
      );
      return;
    }

    if (!isEventEmitterLike(dispatchResult)) {
      item.finalize(new Error('Expected event-emitter result from submittable query dispatch'));
      return;
    }

    const onEnd = (): void => item.finalize(null);
    const onError = (error: unknown): void => item.finalize(toError(error));

    item.cleanup = (): void => {
      dispatchResult.off('end', onEnd);
      dispatchResult.off('error', onError);
    };

    dispatchResult.once('end', onEnd);
    dispatchResult.once('error', onError);
  } catch (error) {
    item.finalize(toError(error));
    hooks.schedulePump();
  }
}
