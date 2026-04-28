import { describe, it, expect, vi } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import {
  makeClient,
  asPoolClient,
  flushMicrotasks,
  FakeSubmittable,
} from '../helpers/fake-client.js';

describe('drain event', () => {
  describe('drain fires on transition from non-empty to empty', () => {
    it('emits drain after the last queued item completes', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      const p1 = client.query('SELECT 1');
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      expect(drainSpy).not.toHaveBeenCalled();

      raw.resolveNext();
      await flushMicrotasks();

      expect(drainSpy).not.toHaveBeenCalled();

      raw.resolveNext();
      await flushMicrotasks();

      expect(drainSpy).toHaveBeenCalledTimes(1);
      await Promise.all([p1, p2]);
    });

    it('emits drain after a single query completes', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      const p1 = client.query('SELECT 1');
      await flushMicrotasks();

      expect(drainSpy).not.toHaveBeenCalled();

      raw.resolveNext();
      await flushMicrotasks();

      expect(drainSpy).toHaveBeenCalledTimes(1);
      await p1;
    });
  });

  describe('drain does not double-fire', () => {
    it('does not emit drain again on subsequent pump ticks when already idle', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      const p1 = client.query('SELECT 1');
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(drainSpy).toHaveBeenCalledTimes(1);

      // Extra microtask flushes should not emit drain again
      await flushMicrotasks();
      await flushMicrotasks();

      expect(drainSpy).toHaveBeenCalledTimes(1);
      await p1;
    });

    it('emits drain again after a second batch of work drains', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      // First batch
      const p1 = client.query('SELECT 1');
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();
      expect(drainSpy).toHaveBeenCalledTimes(1);

      // Second batch
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();
      expect(drainSpy).toHaveBeenCalledTimes(2);

      await Promise.all([p1, p2]);
    });
  });

  describe('drain suppressed after broken state', () => {
    it('does not emit drain after fatal error', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      const p1 = client.query('SELECT 1');
      void p1.catch(() => {}); // suppress unhandled rejection warning
      await flushMicrotasks();

      raw.emit('error', new Error('fatal'));
      await flushMicrotasks();

      expect(drainSpy).not.toHaveBeenCalled();
      await p1.catch(() => {});
    });
  });

  describe('drain suppressed after rawReleased', () => {
    it('does not emit drain after raw client is released', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      const p1 = client.query('SELECT 1');
      await flushMicrotasks();

      client.release();
      raw.resolveNext();
      await flushMicrotasks();

      // release triggered raw release, not a drain event
      expect(raw.releaseCalls).toHaveLength(1);
      expect(drainSpy).not.toHaveBeenCalled();
      await p1;
    });
  });

  describe('drain with emitDrain: false', () => {
    it('does not emit drain event when emitDrain option is false', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw), { emitDrain: false });
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      const p1 = client.query('SELECT 1');
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(drainSpy).not.toHaveBeenCalled();
      await p1;
    });
  });

  describe('drain with synchronously settling items', () => {
    it('emits drain exactly once after a sequence of quick queries', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);

      const p1 = client.query('SELECT 1');
      const p2 = client.query('SELECT 2');
      await flushMicrotasks();

      // Resolve first, flush so pump dispatches second, then resolve second
      raw.resolveNext();
      await flushMicrotasks();
      raw.resolveNext();
      await flushMicrotasks();

      expect(drainSpy).toHaveBeenCalledTimes(1);
      await Promise.all([p1, p2]);
    });
  });

  describe('drain with submittable', () => {
    it('emits drain after submittable end event', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);
      const submittable = new FakeSubmittable();

      client.query(submittable);
      await flushMicrotasks();

      expect(drainSpy).not.toHaveBeenCalled();

      submittable.succeed();
      await flushMicrotasks();

      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('emits drain after submittable error event', async () => {
      const raw = makeClient();
      const client = wrapClient(asPoolClient(raw));
      const drainSpy = vi.fn();
      client.on('drain', drainSpy);
      const submittable = new FakeSubmittable();

      client.query(submittable);
      await flushMicrotasks();

      submittable.fail(new Error('cursor error'));
      await flushMicrotasks();

      expect(drainSpy).toHaveBeenCalledTimes(1);
    });
  });
});
