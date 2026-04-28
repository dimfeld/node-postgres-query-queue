import { describe, it, expect, vi } from 'vitest';
import { Client, type PoolClient } from 'pg';
import { wrapClient } from '../../src/wrap-client.js';
import { makeClient, asPoolClient, flushMicrotasks } from '../helpers/fake-client.js';

function makeActualPgClient(): {
  raw: PoolClient;
  release: ReturnType<typeof vi.fn>;
} {
  const raw = new Client() as Client & {
    release: (err?: Error | boolean) => void;
  };
  const release = vi.fn((_err?: Error | boolean) => {});
  raw.release = release;
  return { raw: raw as unknown as PoolClient, release };
}

describe('client API passthroughs', () => {
  it('wraps an actual pg Client without requiring missing optional methods', async () => {
    const { raw, release } = makeActualPgClient();

    const client = wrapClient(raw);

    expect(client.unwrap()).toBe(raw);

    const wrapped = client as unknown as Record<string, unknown>;
    const actual = raw as unknown as Record<string, unknown>;
    for (const key of ['copyFrom', 'copyTo', 'pauseDrain', 'resumeDrain']) {
      if (actual[key] === undefined) {
        expect(wrapped[key]).toBeUndefined();
      } else {
        expect(typeof wrapped[key]).toBe('function');
      }
    }

    expect(client.escapeIdentifier('job"name')).toBe('"job""name"');
    client.release();
    await flushMicrotasks();

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]).toEqual([]);
  });

  it('passes implemented non-query PoolClient methods through to the raw client', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const parser = vi.fn((value: string) => Number(value));

    expect(await client.connect()).toBe(raw);
    expect(client.escapeIdentifier('job"name')).toBe('"job""name"');
    expect(client.escapeLiteral("job'name")).toBe("'job''name'");

    client.setTypeParser(20, parser);
    expect(client.getTypeParser(20)('42')).toBe(42);
    client.ref();
    client.unref();

    expect(raw.connect).toHaveBeenCalledOnce();
  });

  it('passes release(true) through when raw release runs', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));

    client.release(true);
    await flushMicrotasks();

    expect(raw.release).toHaveBeenCalledWith(true);
    expect(raw.releaseCalls).toEqual([{ err: true }]);
  });
});
