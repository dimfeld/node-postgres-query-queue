import { describe, it, expect, vi } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import { makeClient, asPoolClient } from '../helpers/fake-client.js';

describe('invalid query input', () => {
  it('throws synchronously for null query input', () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));

    expect(() => {
      client.query(null as never);
    }).toThrow(TypeError);

    expect(raw.queryCallLog).toHaveLength(0);
    expect(client.queueSnapshot()).toEqual({
      queued: 0,
      running: false,
      releaseRequested: false,
      broken: false,
    });
  });

  it('throws synchronously for undefined query input', () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));

    expect(() => {
      client.query(undefined as never);
    }).toThrow(TypeError);

    expect(raw.queryCallLog).toHaveLength(0);
    expect(client.queueSize).toBe(0);
  });

  it('throws synchronously for callback form with null query input', () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const callback = vi.fn();

    expect(() => {
      client.query(null as never, callback);
    }).toThrow(TypeError);

    expect(callback).not.toHaveBeenCalled();
    expect(raw.queryCallLog).toHaveLength(0);
    expect(client.queueSize).toBe(0);
  });
});
