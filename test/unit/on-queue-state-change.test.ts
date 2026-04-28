import { describe, it, expect } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import type { QueueSnapshot } from '../../src/types.js';
import {
  makeClient,
  asPoolClient,
  flushMicrotasks,
  FakeSubmittable,
} from '../helpers/fake-client.js';

describe('onQueueStateChange', () => {
  it('fires on enqueue (running=true) and finalize (idle)', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
    });

    client.query('SELECT 1');
    await flushMicrotasks();

    // After enqueue+dispatch: running=true, queued=0
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const dispatchSnap = snapshots.find((s) => s.running);
    expect(dispatchSnap).toBeDefined();
    expect(dispatchSnap?.queued).toBe(0);

    raw.resolveNext();
    await flushMicrotasks();

    // After finalize: running=false, queued=0
    const finalSnap = snapshots[snapshots.length - 1]!;
    expect(finalSnap.running).toBe(false);
    expect(finalSnap.queued).toBe(0);
  });

  it('fires on enqueue with queued > 0 when a query is already running', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
    });

    client.query('SELECT 1'); // dispatched immediately
    client.query('SELECT 2'); // queued
    await flushMicrotasks();

    // Should have a snapshot showing queued=1, running=true
    const queuedSnap = snapshots.find((s) => s.queued === 1 && s.running);
    expect(queuedSnap).toBeDefined();

    raw.resolveNext();
    await flushMicrotasks();
    raw.resolveNext();
    await flushMicrotasks();
  });

  it('fires on release with releaseRequested=true', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
    });

    client.release();
    await flushMicrotasks();

    const relSnap = snapshots.find((s) => s.releaseRequested);
    expect(relSnap).toBeDefined();
    expect(relSnap?.broken).toBe(false);
  });

  it('fires on fatal error with broken=true', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
    });

    const p = client.query('SELECT 1').catch(() => {});
    await flushMicrotasks();

    const fatalError = new Error('fatal connection error');
    raw.emit('error', fatalError);
    await flushMicrotasks();

    const brokenSnap = snapshots.find((s) => s.broken);
    expect(brokenSnap).toBeDefined();

    await p;
  });

  it('dedupes identical consecutive snapshots', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
    });

    // With one query: enqueue triggers notification (running=true).
    // Pump runs once; no second identical notification should be fired.
    client.query('SELECT 1');
    await flushMicrotasks();

    // Count snapshots with running=true, queued=0 — should be exactly 1
    const runningSnaps = snapshots.filter((s) => s.running && s.queued === 0);
    expect(runningSnaps).toHaveLength(1);

    raw.resolveNext();
    await flushMicrotasks();
  });

  it('does not emit duplicate snapshots when the same state would be reported twice', async () => {
    const raw = makeClient();
    const calls: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => calls.push({ ...s }),
    });

    // Enqueue two queries at once. The second enqueue happens when running=true, queued=1.
    // After first query finishes, the second is dispatched (running=true, queued=0).
    // No two consecutive calls should carry identical snapshots.
    client.query('SELECT 1');
    client.query('SELECT 2');
    await flushMicrotasks();

    for (let i = 1; i < calls.length; i++) {
      const prev = calls[i - 1]!;
      const cur = calls[i]!;
      const identical =
        prev.queued === cur.queued &&
        prev.running === cur.running &&
        prev.releaseRequested === cur.releaseRequested &&
        prev.broken === cur.broken;
      expect(identical, `snapshots at index ${i - 1} and ${i} are identical`).toBe(false);
    }

    raw.resolveNext();
    await flushMicrotasks();
    raw.resolveNext();
    await flushMicrotasks();
  });

  it('continues queue progress when onQueueStateChange throws', async () => {
    const raw = makeClient();
    const hookError = new Error('queue hook failed');
    let calls = 0;
    const deferredThrow = new Promise<unknown>((resolve) => {
      process.once('uncaughtException', resolve);
    });
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: () => {
        calls += 1;
        if (calls === 1) {
          throw hookError;
        }
      },
    });

    const first = client.query('SELECT 1');
    const second = client.query('SELECT 2');

    await expect(deferredThrow).resolves.toBe(hookError);
    await flushMicrotasks();

    expect(raw.queryCallLog).toHaveLength(1);

    raw.resolveNext();
    await flushMicrotasks();

    expect(raw.queryCallLog).toHaveLength(2);

    raw.resolveNext();
    await Promise.all([first, second]);
  });

  it('fires correctly for the full enqueue→dispatch→finalize→release sequence', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
    });

    client.query('SELECT 1');
    await flushMicrotasks();

    // Dispatch snapshot
    expect(snapshots.some((s) => s.running && !s.releaseRequested && !s.broken)).toBe(true);

    raw.resolveNext();
    await flushMicrotasks();

    // Finalize snapshot
    expect(snapshots.some((s) => !s.running && !s.releaseRequested && !s.broken)).toBe(true);

    // Now release
    client.release();
    await flushMicrotasks();

    // Release snapshot
    expect(snapshots.some((s) => s.releaseRequested)).toBe(true);
  });

  it('fires for submittable dispatch and completion (end)', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
    });

    const sub = new FakeSubmittable();
    client.query(sub as unknown as Parameters<typeof client.query>[0]);
    await flushMicrotasks();

    // dispatched → running=true
    expect(snapshots.some((s) => s.running)).toBe(true);

    sub.succeed();
    await flushMicrotasks();

    // completed → running=false
    const lastSnap = snapshots[snapshots.length - 1]!;
    expect(lastSnap.running).toBe(false);
  });

  it('fires for release(err) with abortQueuedQueriesOnReleaseError=true', async () => {
    const raw = makeClient();
    const snapshots: QueueSnapshot[] = [];
    const client = wrapClient(asPoolClient(raw), {
      onQueueStateChange: (s) => snapshots.push({ ...s }),
      abortQueuedQueriesOnReleaseError: true,
    });

    const p1 = client.query('SELECT 1').catch(() => {});
    const p2 = client.query('SELECT 2').catch(() => {});
    await flushMicrotasks();

    const err = new Error('connection failed');
    client.release(err);
    await flushMicrotasks();

    expect(snapshots.some((s) => s.releaseRequested)).toBe(true);

    await p1;
    await p2;
  });
});
