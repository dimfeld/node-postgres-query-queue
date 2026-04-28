import type { PoolClient } from 'pg';
export type QueueItemKind = 'promise' | 'callback' | 'submittable';
export interface QueueItem {
    kind: QueueItemKind;
    dispatch: (raw: PoolClient) => unknown;
    finalize: (err: Error | null, result?: unknown) => void;
    cleanup?: () => void;
    description?: string;
}
export declare class FifoQueue<T> {
    private items;
    private head;
    get length(): number;
    push(item: T): void;
    shift(): T | undefined;
    drain(): T[];
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
export declare function pump(state: PumpState, hooks: PumpHooks): void;
//# sourceMappingURL=queue.d.ts.map