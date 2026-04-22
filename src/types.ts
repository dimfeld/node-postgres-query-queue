import type { EventEmitter } from 'node:events';
import type { Pool, PoolClient, QueryResult } from 'pg';

export interface QueueSnapshot {
  queued: number;
  running: boolean;
  releaseRequested: boolean;
  broken: boolean;
}

export interface WrappedPoolOptions {
  abortQueuedQueriesOnReleaseError?: boolean;
  emitDrain?: boolean;
  onQueueStateChange?: (snapshot: QueueSnapshot) => void;
}

export interface WrappedPool extends Omit<Pool, 'connect'> {
  connect(): Promise<WrappedPoolClient>;
}

export interface WrappedPoolClient extends Omit<PoolClient, 'release'> {
  release(err?: Error | boolean): void;
  ref(): void;
  unref(): void;
  readonly queueSize: number;
  readonly isReleased: boolean;
  queueSnapshot(): QueueSnapshot;
  unwrap(): PoolClient;
}

export type QueryCallback = (err: Error | null, result?: QueryResult) => void;

export type WrappedPoolClientEmitter = EventEmitter & WrappedPoolClient;
