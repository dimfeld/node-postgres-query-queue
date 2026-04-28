import type { PoolClient, QueryResult } from 'pg';

export interface PromiseQueryArgs {
  kind: 'promise';
  dispatch: (raw: PoolClient) => unknown;
  description?: string;
}

export interface CallbackQueryArgs {
  kind: 'callback';
  dispatchArgs: unknown[];
  dispatch: (raw: PoolClient) => unknown;
  userCallback: (err: Error | null, result?: QueryResult) => void;
  description?: string;
}

export interface SubmittableQueryArgs {
  kind: 'submittable';
  dispatch: (raw: PoolClient) => unknown;
  description?: string;
}

export type NormalizedQueryArgs = PromiseQueryArgs | CallbackQueryArgs | SubmittableQueryArgs;

interface SubmittableLike {
  submit: (...args: unknown[]) => unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSubmittable(value: unknown): value is SubmittableLike {
  return isObject(value) && typeof value.submit === 'function';
}

function hasConfigCallback(value: unknown): value is Record<string, unknown> & {
  callback: (err: Error | null, result?: QueryResult) => void;
} {
  return isObject(value) && typeof value.callback === 'function';
}

function readDescription(firstArg: unknown): string | undefined {
  if (typeof firstArg === 'string') {
    return firstArg.slice(0, 80);
  }

  if (isObject(firstArg) && typeof firstArg.text === 'string') {
    return firstArg.text.slice(0, 80);
  }

  return undefined;
}

function dispatchQuery(raw: PoolClient, args: unknown[]): unknown {
  return (raw.query as (...queryArgs: unknown[]) => unknown)(...args);
}

export function normalizeQueryArgs(args: unknown[]): NormalizedQueryArgs {
  const firstArg = args[0];
  const description = readDescription(firstArg);

  if (isSubmittable(firstArg)) {
    const preservedArgs = [...args];
    return {
      kind: 'submittable',
      dispatch: (raw: PoolClient) => dispatchQuery(raw, preservedArgs),
      ...(description !== undefined ? { description } : {}),
    };
  }

  const lastArg = args.at(-1);
  if (typeof lastArg === 'function') {
    const userCallback = lastArg as (err: Error | null, result?: QueryResult) => void;
    const dispatchArgs = args.slice(0, -1);

    return {
      kind: 'callback',
      dispatchArgs,
      dispatch: (raw: PoolClient) => dispatchQuery(raw, dispatchArgs),
      userCallback,
      ...(description !== undefined ? { description } : {}),
    };
  }

  if (hasConfigCallback(firstArg)) {
    const { callback, ...dispatchConfig } = firstArg;

    return {
      kind: 'callback',
      dispatchArgs: [dispatchConfig, ...args.slice(1)],
      dispatch: (raw: PoolClient) => dispatchQuery(raw, [dispatchConfig, ...args.slice(1)]),
      userCallback: callback,
      ...(description !== undefined ? { description } : {}),
    };
  }

  const preservedArgs = [...args];
  return {
    kind: 'promise',
    dispatch: (raw: PoolClient) => dispatchQuery(raw, preservedArgs),
    ...(description !== undefined ? { description } : {}),
  };
}
