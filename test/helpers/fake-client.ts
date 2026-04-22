import { EventEmitter } from 'node:events';
import { Client, type PoolClient, type QueryResult } from 'pg';
import { vi } from 'vitest';

const DEFAULT_RESULT: QueryResult = {
  rows: [],
  rowCount: 0,
  command: 'SELECT',
  oid: 0,
  fields: [],
};

type PendingPromise = {
  kind: 'promise';
  args: unknown[];
  resolve: (result: QueryResult) => void;
  reject: (error: Error) => void;
};

type PendingCallback = {
  kind: 'callback';
  args: unknown[];
  callback: (err: Error | null, result?: QueryResult) => void;
};

type PendingQuery = PendingPromise | PendingCallback;

function isSubmittableLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).submit === 'function'
  );
}

export class FakePoolClient extends Client {
  queryCallLog: unknown[][] = [];
  releaseCalls: Array<{ err: Error | boolean | undefined }> = [];
  private _pendingQueries: PendingQuery[] = [];

  get pendingCount(): number {
    return this._pendingQueries.length;
  }

  query = ((...args: unknown[]): unknown => {
    this.queryCallLog.push([...args]);

    const firstArg = args[0];
    if (isSubmittableLike(firstArg)) {
      // Return the submittable itself so pump can attach end/error listeners
      return firstArg;
    }

    const lastArg = args.at(-1);
    if (typeof lastArg === 'function') {
      const callback = lastArg as (err: Error | null, result?: QueryResult) => void;
      this._pendingQueries.push({ kind: 'callback', args: args.slice(0, -1), callback });
      return undefined;
    }

    return new Promise<QueryResult>((resolve, reject) => {
      this._pendingQueries.push({ kind: 'promise', args: [...args], resolve, reject });
    });
  }) as any;

  connect = vi.fn((): Promise<Client> => Promise.resolve(this)) as any;

  resolveNext(result: Partial<QueryResult> = {}): void {
    const pending = this._pendingQueries.shift();
    if (!pending) throw new Error('No pending queries to resolve');
    const fullResult = { ...DEFAULT_RESULT, ...result };
    if (pending.kind === 'callback') {
      pending.callback(null, fullResult);
    } else {
      pending.resolve(fullResult);
    }
  }

  rejectNext(error: Error): void {
    const pending = this._pendingQueries.shift();
    if (!pending) throw new Error('No pending queries to reject');
    if (pending.kind === 'callback') {
      pending.callback(error);
    } else {
      pending.reject(error);
    }
  }

  release = vi.fn((err?: Error | boolean): void => {
    this.releaseCalls.push({ err });
  });
}

export function makeClient(): FakePoolClient {
  return new FakePoolClient();
}

export class FakeSubmittable extends EventEmitter {
  submit = vi.fn();

  succeed(): void {
    this.emit('end');
  }

  fail(err: Error): void {
    this.emit('error', err);
  }
}

/** Flush all pending microtasks. Use after resolving/rejecting fake queries. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Cast a FakePoolClient to PoolClient for use with wrapClient */
export function asPoolClient(client: FakePoolClient): PoolClient {
  return client as unknown as PoolClient;
}
