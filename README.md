# node-postgres-query-queue

`node-postgres-query-queue` restores per-client FIFO query serialization on top of modern `pg` versions that no longer provide an internal client query queue. Wrap a `pg.Pool`, keep existing `client.query(...)` call shapes, and serialize work per checked-out client in user space.

## Install

```bash
pnpm add node-postgres-query-queue pg
```

`pg` is a peer dependency and must be installed by the consuming application (`^8 || ^9`).

## Quickstart

```ts
import { Pool } from 'pg';
import { wrapPool } from 'node-postgres-query-queue';

const pool = wrapPool(new Pool({ connectionString: process.env.DATABASE_URL }));
const client = await pool.connect();
try {
  // These two calls do NOT need to be awaited sequentially.
  // The wrapper serializes them FIFO against one underlying pg client.
  const a = client.query('SELECT 1');
  const b = client.query('SELECT 2');
  const [ra, rb] = await Promise.all([a, b]);
} finally {
  client.release();
}
```

## API Reference

### `wrapPool(pool, options?) => WrappedPool`

Wraps a `pg.Pool` and delegates pool behavior. The wrapper changes `connect()` so it returns `WrappedPoolClient`.

- `connect()` promise form is supported.
- `connect(callback)` is not supported in v1 and throws: `connect(callback) is not supported by the wrapped pool; use the promise form`.
- `pool.query(...)` remains a direct passthrough to the underlying pool.

### `wrapClient(rawClient, options?) => WrappedPoolClient`

Wraps an already checked-out `PoolClient` directly. Useful when a pool wrapper is not practical and you only need queueing semantics for a specific client.

### `WrappedPoolOptions`

- `abortQueuedQueriesOnReleaseError?: boolean` (default: `true`)
  - `true`: `release(err)` rejects active and queued items immediately with `ReleaseAbortedError` and releases the raw client with the error.
  - `false`: `release(err)` keeps draining queued items, then releases with `err`.
- `emitDrain?: boolean` (default behavior emits `drain`)
  - Set to `false` to suppress wrapper-emitted `drain`.
- `onQueueStateChange?: (snapshot: QueueSnapshot) => void`
  - Called on queue state mutations.

`QueueSnapshot`:

- `queued: number`
- `running: boolean`
- `releaseRequested: boolean`
- `broken: boolean`

### `WrappedPoolClient` extras

- `queueSize: number` — queued item count (not including active item).
- `isReleased: boolean` — true after release requested or raw release occurred.
- `unwrap(): PoolClient` — returns the raw client (bypasses queueing guarantees).
- `queueSnapshot(): QueueSnapshot` — current queue state view.
- `'drain'` event — emitted when queue transitions to empty with no active task (unless `emitDrain: false`).

### Error Classes

- `ClientReleasedError`
  - Message: `Client has been released and cannot accept new queued queries`
- `ClientBrokenError`
  - Message: `Wrapped client is broken and cannot accept new queued queries`
- `ReleaseAbortedError`
  - Message: `Queued query was aborted because the client was released with an error`
- `DoubleReleaseError`
  - Message: `Release called more than once on wrapped client`

## Differences From Legacy `pg`

1. `query_timeout` starts at dispatch to the raw client, not when a query is enqueued. If
   `pg` reports `Query read timeout`, the wrapper treats the client as broken, rejects
   queued work with `ClientBrokenError`, and releases the raw client with the timeout
   error so the pool discards it.
2. Queued-but-not-dispatched items are not canceled through `pg` internals; abandon returned promises or call `release(err)` to abort queued work.
3. `pool.query(...)` is passthrough behavior and does not participate in wrapped per-client queueing; use `pool.connect()`.
4. Submittable support targets `pg-cursor`-style objects; completion is detected via `end`/`error`, plus callback errors for `pg.Query` objects. `close` is not observed.
5. Callback-form `pool.connect(cb)` is not supported in v1.
6. Callback-form queries queued behind an active item return `undefined` instead of a native `pg` `Query` instance.
7. Queued submittables (e.g. `pg-cursor`) that are aborted before dispatch — via `release(err)` with the default abort policy, or via a fatal raw-client error — are not `submit()`'d. When a submittable exposes `handleError` or `callback`, the wrapper reports the abort through that API.

## Release Semantics

Plain `release()` drains queued work before returning the raw client:

```ts
client.query('SELECT 1');
client.query('SELECT 2');
client.release();
```

`release(err)` with default `abortQueuedQueriesOnReleaseError: true` aborts active and queued work and releases the raw client with the error immediately:

```ts
client.query('SELECT pg_sleep(1)');
client.query('SELECT 2');
client.release(new Error('connection is unhealthy'));
```

## Testing

`pnpm test` runs unit tests and real PostgreSQL integration tests. The integration
suite uses `DATABASE_URL` when set, then `PG_INTEGRATION_URL`, and otherwise
connects to `localhost:5432` using database `postgres` plus standard `PG*`
environment variables.

## License

See [LICENSE](./LICENSE) (`Apache-2.0`).
