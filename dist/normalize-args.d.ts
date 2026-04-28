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
export declare function normalizeQueryArgs(args: unknown[]): NormalizedQueryArgs;
//# sourceMappingURL=normalize-args.d.ts.map