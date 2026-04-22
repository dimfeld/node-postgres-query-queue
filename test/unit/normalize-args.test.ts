import type { PoolClient, QueryResult } from 'pg';
import { describe, it, expect, vi } from 'vitest';
import { normalizeQueryArgs } from '../../src/normalize-args.js';

function makeFakeClient() {
  const calls: unknown[][] = [];
  const client = {
    query: vi.fn((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    }),
    calls,
  };
  return client as unknown as PoolClient & { calls: unknown[][] };
}

describe('normalizeQueryArgs', () => {
  describe('submittable detection', () => {
    it('detects submittable when first arg has submit function', () => {
      const submittable = { submit: () => {} };
      const result = normalizeQueryArgs([submittable]);
      expect(result.kind).toBe('submittable');
    });

    it('returns no userCallback for submittable', () => {
      const submittable = { submit: () => {} };
      const result = normalizeQueryArgs([submittable]);
      expect('userCallback' in result).toBe(false);
    });

    it('description is undefined for submittable without text', () => {
      const submittable = { submit: () => {} };
      const result = normalizeQueryArgs([submittable]);
      expect(result.description).toBeUndefined();
    });

    it('submittable dispatch passes the submittable to rawClient.query', () => {
      const submittable = { submit: () => {} };
      const result = normalizeQueryArgs([submittable]);
      const client = makeFakeClient();
      result.dispatch(client);
      expect(vi.mocked(client.query)).toHaveBeenCalledWith(submittable);
    });

    it('takes precedence over callback detection when first arg is submittable', () => {
      const submittable = { submit: () => {} };
      const cb = () => {};
      const result = normalizeQueryArgs([submittable, cb]);
      expect(result.kind).toBe('submittable');
    });
  });

  describe('callback detection', () => {
    it('detects (text, cb) as callback kind', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs(['SELECT 1', cb]);
      expect(result.kind).toBe('callback');
    });

    it('sets userCallback for (text, cb)', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs(['SELECT 1', cb]);
      if (result.kind !== 'callback') throw new Error('expected callback');
      expect(result.userCallback).toBe(cb);
    });

    it('detects (text, values, cb) as callback kind', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs(['SELECT $1', [1], cb]);
      expect(result.kind).toBe('callback');
    });

    it('sets userCallback for (text, values, cb)', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs(['SELECT $1', [1], cb]);
      if (result.kind !== 'callback') throw new Error('expected callback');
      expect(result.userCallback).toBe(cb);
    });

    it('detects (config, cb) as callback kind', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs([{ text: 'SELECT 1' }, cb]);
      expect(result.kind).toBe('callback');
    });

    it('sets userCallback for (config, cb)', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs([{ text: 'SELECT 1' }, cb]);
      if (result.kind !== 'callback') throw new Error('expected callback');
      expect(result.userCallback).toBe(cb);
    });

    it('detects ({ text, callback }) as callback kind', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs([{ text: 'SELECT 1', callback: cb }]);
      expect(result.kind).toBe('callback');
      if (result.kind !== 'callback') throw new Error('expected callback');
      expect(result.userCallback).toBe(cb);
    });

    it('detects ({ text, callback }, values) as callback kind', () => {
      const cb = vi.fn();
      const values = [1];
      const result = normalizeQueryArgs([{ text: 'SELECT $1', callback: cb }, values]);
      expect(result.kind).toBe('callback');
      if (result.kind !== 'callback') throw new Error('expected callback');
      expect(result.userCallback).toBe(cb);
      expect(result.dispatchArgs).toEqual([{ text: 'SELECT $1' }, values]);
    });

    it('dispatch strips the callback before calling rawClient.query', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs(['SELECT 1', cb]);
      const client = makeFakeClient();
      result.dispatch(client);
      expect(vi.mocked(client.query)).toHaveBeenCalledWith('SELECT 1');
      expect(vi.mocked(client.query)).not.toHaveBeenCalledWith('SELECT 1', cb);
    });

    it('dispatch strips the callback for (text, values, cb)', () => {
      const cb = vi.fn();
      const values = [1];
      const result = normalizeQueryArgs(['SELECT $1', values, cb]);
      const client = makeFakeClient();
      result.dispatch(client);
      expect(vi.mocked(client.query)).toHaveBeenCalledWith('SELECT $1', values);
    });

    it('dispatch strips callback from ({ text, callback }) config', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs([{ text: 'SELECT 1', values: [1], callback: cb }]);
      const client = makeFakeClient();
      result.dispatch(client);
      expect(vi.mocked(client.query)).toHaveBeenCalledWith({
        text: 'SELECT 1',
        values: [1],
      });
    });

    it('dispatch strips callback and preserves values for ({ text, callback }, values)', () => {
      const cb = vi.fn();
      const values = [1];
      const result = normalizeQueryArgs([{ text: 'SELECT $1', callback: cb }, values]);
      const client = makeFakeClient();
      result.dispatch(client);
      expect(vi.mocked(client.query)).toHaveBeenCalledWith({ text: 'SELECT $1' }, values);
    });
  });

  describe('promise detection', () => {
    it('detects (text) as promise kind', () => {
      const result = normalizeQueryArgs(['SELECT 1']);
      expect(result.kind).toBe('promise');
    });

    it('detects (text, values) as promise kind', () => {
      const result = normalizeQueryArgs(['SELECT $1', [1]]);
      expect(result.kind).toBe('promise');
    });

    it('detects (config) as promise kind', () => {
      const result = normalizeQueryArgs([{ text: 'SELECT 1' }]);
      expect(result.kind).toBe('promise');
    });

    it('has no userCallback for promise kind', () => {
      const result = normalizeQueryArgs(['SELECT 1']);
      expect('userCallback' in result).toBe(false);
    });

    it('dispatch passes all args to rawClient.query', () => {
      const values = [42];
      const result = normalizeQueryArgs(['SELECT $1', values]);
      const client = makeFakeClient();
      result.dispatch(client);
      expect(vi.mocked(client.query)).toHaveBeenCalledWith('SELECT $1', values);
    });

    it('dispatch passes config object to rawClient.query', () => {
      const config = { text: 'SELECT 1', values: [1] };
      const result = normalizeQueryArgs([config]);
      const client = makeFakeClient();
      result.dispatch(client);
      expect(vi.mocked(client.query)).toHaveBeenCalledWith(config);
    });
  });

  describe('description extraction', () => {
    it('sets description from text string', () => {
      const result = normalizeQueryArgs(['SELECT 1']);
      expect(result.description).toBe('SELECT 1');
    });

    it('sets description from config.text', () => {
      const result = normalizeQueryArgs([{ text: 'SELECT 1' }]);
      expect(result.description).toBe('SELECT 1');
    });

    it('truncates description to 80 chars', () => {
      const longQuery = 'SELECT ' + 'x'.repeat(100);
      const result = normalizeQueryArgs([longQuery]);
      expect(result.description).toHaveLength(80);
      expect(result.description).toBe(longQuery.slice(0, 80));
    });

    it('description is undefined when first arg has no text', () => {
      const submittable = { submit: () => {} };
      const result = normalizeQueryArgs([submittable]);
      expect(result.description).toBeUndefined();
    });

    it('description is set for callback form', () => {
      const cb = vi.fn();
      const result = normalizeQueryArgs(['SELECT 1', cb]);
      expect(result.description).toBe('SELECT 1');
    });
  });
});
