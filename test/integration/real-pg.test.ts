import { performance } from 'node:perf_hooks';
import Cursor from 'pg-cursor';
import { Pool, Query, type PoolConfig, type QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClientBrokenError,
  ReleaseAbortedError,
  wrapPool,
  type WrappedPoolClient,
} from '../../src/index.js';

const INTEGRATION_DB_CONFIG: PoolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : process.env.PG_INTEGRATION_URL
    ? { connectionString: process.env.PG_INTEGRATION_URL }
    : {
        host: 'localhost',
        port: 5432,
        database: process.env.PGDATABASE ?? 'postgres',
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
      };

function integrationDbDescription(): string {
  if (process.env.DATABASE_URL) {
    return 'DATABASE_URL';
  }

  if (process.env.PG_INTEGRATION_URL) {
    return 'PG_INTEGRATION_URL';
  }

  return 'localhost:5432';
}

function readCursor(
  cursor: Cursor<unknown>,
  rowCount: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    cursor.read(rowCount, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows as Array<Record<string, unknown>>);
    });
  });
}

function closeCursor(cursor: Cursor<unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    cursor.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitForIdle(pool: Pool, expectedIdleCount: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (pool.idleCount !== expectedIdleCount && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function clientQueryCallback(
  client: WrappedPoolClient,
  text: string,
  values?: unknown[],
): Promise<QueryResult> {
  return new Promise<QueryResult>((resolve, reject) => {
    const callback = (error: Error | null, result?: QueryResult): void => {
      if (error) {
        reject(error);
        return;
      }

      if (result === undefined) {
        reject(new Error('query callback did not receive a result'));
        return;
      }

      resolve(result);
    };

    if (values === undefined) {
      client.query(text, callback);
    } else {
      client.query(text, values, callback);
    }
  });
}

describe(`integration with real postgres (${integrationDbDescription()})`, () => {
  let rawPool: Pool;
  let wrappedPool: ReturnType<typeof wrapPool>;

  beforeAll(() => {
    rawPool = new Pool(INTEGRATION_DB_CONFIG);
    wrappedPool = wrapPool(rawPool);
  });

  afterAll(async () => {
    await rawPool.end();
  });

  it('serializes two unawaited queries on one wrapped client', async () => {
    const client = await wrappedPool.connect();
    try {
      const start = performance.now();
      const first = client.query('SELECT pg_sleep(0.05)');
      const second = client.query('SELECT pg_sleep(0.05)');

      await Promise.all([first, second]);
      const elapsedMs = performance.now() - start;

      expect(elapsedMs).toBeGreaterThanOrEqual(95);
    } finally {
      client.release();
    }
  });

  it('resolves a large same-client backlog in FIFO order', { timeout: 10_000 }, async () => {
    const client = await wrappedPool.connect();
    try {
      const count = 250;
      const resolvedOrder: number[] = [];

      const queries = Array.from({ length: count }, (_, index) =>
        client.query('SELECT $1::int AS n', [index]).then((result) => {
          resolvedOrder.push(Number((result as QueryResult).rows[0]!.n));
          return result;
        }),
      );

      await Promise.all(queries);

      expect(resolvedOrder).toEqual(Array.from({ length: count }, (_, index) => index));
    } finally {
      client.release();
    }
  });

  it('preserves ordering across promise and callback query forms', async () => {
    const client = await wrappedPool.connect();
    try {
      const order: string[] = [];

      const first = client.query('SELECT pg_sleep(0.02), 1 AS n').then(() => {
        order.push('promise-1');
      });
      const second = clientQueryCallback(client, 'SELECT 2 AS n').then((result) => {
        expect(result.rows[0]).toMatchObject({ n: 2 });
        order.push('callback-2');
      });
      const third = client.query('SELECT 3 AS n').then((result) => {
        expect((result as QueryResult).rows[0]).toMatchObject({ n: 3 });
        order.push('promise-3');
      });

      await Promise.all([first, second, third]);

      expect(order).toEqual(['promise-1', 'callback-2', 'promise-3']);
    } finally {
      client.release();
    }
  });

  it('advances queued real queries after a database error', async () => {
    const client = await wrappedPool.connect();
    try {
      const failed = client.query('SELECT definitely_missing_column').catch((error) => error);
      const next = client.query('SELECT 42::int AS n');

      await expect(failed).resolves.toBeInstanceOf(Error);
      await expect(next).resolves.toMatchObject({
        rows: [{ n: 42 }],
      });
    } finally {
      client.release();
    }
  });

  it('queues pg-cursor behind a normal query and starts cursor work after it', async () => {
    const client = await wrappedPool.connect();
    try {
      let priorResolvedAt = 0;
      let cursorReadAt = 0;

      const priorQuery = client.query('SELECT pg_sleep(0.05)').then((result) => {
        priorResolvedAt = performance.now();
        return result;
      });

      const cursor = client.query(
        new Cursor('SELECT generate_series(1,3) AS n'),
      ) as Cursor<unknown>;

      const rowsPromise = readCursor(cursor, 10).then((rows) => {
        cursorReadAt = performance.now();
        return rows;
      });

      const [priorResult, rows] = (await Promise.all([priorQuery, rowsPromise])) as [
        QueryResult,
        Array<Record<string, unknown>>,
      ];

      expect(priorResult.rowCount).toBe(1);
      expect(rows).toHaveLength(3);
      expect(cursorReadAt).toBeGreaterThan(priorResolvedAt);

      await closeCursor(cursor);
    } finally {
      client.release();
    }
  });

  it('reports release(err) to queued cursor reads before dispatch', async () => {
    const client = await wrappedPool.connect();
    const releaseError = new Error('release before cursor dispatch');

    const active = client.query('SELECT pg_sleep(0.05), 1 AS n').catch((error) => error);
    const cursor = client.query(new Cursor('SELECT generate_series(1,3) AS n')) as Cursor<unknown>;
    const rows = readCursor(cursor, 10).catch((error) => error);

    client.release(releaseError);

    await expect(rows).resolves.toBeInstanceOf(ReleaseAbortedError);
    await expect(active).resolves.toBeInstanceOf(ReleaseAbortedError);
  });

  it('advances after a callback-backed pg.Query submittable fails', async () => {
    const client = await wrappedPool.connect();
    try {
      const queryError = new Promise<unknown>((resolve) => {
        client.query(
          new Query('SELECT definitely_missing_column', (error) => {
            resolve(error);
          }),
        );
      });
      const next = client.query('SELECT 7::int AS n');

      await expect(queryError).resolves.toBeInstanceOf(Error);
      await expect(next).resolves.toMatchObject({
        rows: [{ n: 7 }],
      });
    } finally {
      client.release();
    }
  });

  it('drains queued items before releasing raw client', async () => {
    const client = await wrappedPool.connect();

    const first = client.query('SELECT 1');
    const second = client.query('SELECT 1');
    const third = client.query('SELECT 1');

    client.release();

    const [r1, r2, r3] = (await Promise.all([first, second, third])) as [
      QueryResult,
      QueryResult,
      QueryResult,
    ];
    expect(r1.rowCount).toBe(1);
    expect(r2.rowCount).toBe(1);
    expect(r3.rowCount).toBe(1);

    await waitForIdle(rawPool, 1);
    expect(rawPool.idleCount).toBe(1);
  });

  it('aborts queued real work on release(err) before dispatch', async () => {
    const client = await wrappedPool.connect();
    const releaseError = new Error('release under load');

    const active = client.query('SELECT pg_sleep(0.05), 1 AS n').catch((error) => error);
    const queued = Array.from({ length: 25 }, (_, index) =>
      client.query('SELECT $1::int AS n', [index]).catch((error) => error),
    );

    client.release(releaseError);

    const queuedResults = await Promise.all(queued);
    expect(queuedResults.every((result) => result instanceof ReleaseAbortedError)).toBe(true);

    await expect(active).resolves.toBeInstanceOf(ReleaseAbortedError);
  });

  it('treats real pg query_timeout as fatal for queued work', { timeout: 10_000 }, async () => {
    const timeoutPool = new Pool({ ...INTEGRATION_DB_CONFIG, query_timeout: 20 });
    const wrappedTimeoutPool = wrapPool(timeoutPool);

    try {
      const client = await wrappedTimeoutPool.connect();
      const timedOut = client.query('SELECT pg_sleep(1)').catch((error) => error);
      const queued = client.query('SELECT 1').catch((error) => error);

      const [timeoutResult, queuedResult] = await Promise.all([timedOut, queued]);
      expect(timeoutResult).toBeInstanceOf(Error);
      expect((timeoutResult as Error).message).toBe('Query read timeout');
      expect(queuedResult).toBeInstanceOf(ClientBrokenError);
      expect((queuedResult as ClientBrokenError).cause).toBe(timeoutResult);
      expect(client.isReleased).toBe(true);
    } finally {
      await timeoutPool.end();
    }
  });

  it(
    'rejects queued work with ClientBrokenError on fatal client error',
    { timeout: 10_000 },
    async () => {
      const client = await wrappedPool.connect();

      const first = client
        .query('SELECT pg_terminate_backend(pg_backend_pid())')
        .catch((error) => error);
      const queued = client.query('SELECT 1').catch((error) => error);

      await expect(queued).resolves.toBeInstanceOf(ClientBrokenError);
      await expect(first).resolves.toBeInstanceOf(Error);

      expect(client.isReleased).toBe(true);
    },
  );
});
