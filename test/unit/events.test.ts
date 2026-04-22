import { describe, it, expect, vi } from 'vitest';
import { wrapClient } from '../../src/wrap-client.js';
import { ClientBrokenError } from '../../src/errors.js';
import { makeClient, asPoolClient, flushMicrotasks } from '../helpers/fake-client.js';

describe('client events', () => {
  it('forwards raw notice events to wrapper listeners', () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const notice = { message: 'hello' };
    const listener = vi.fn();

    client.on('notice', listener);
    raw.emit('notice', notice);

    expect(listener).toHaveBeenCalledWith(notice);
  });

  it('forwards raw notification events to wrapper listeners', () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const notification = { channel: 'jobs', payload: 'ready' };
    const listener = vi.fn();

    client.on('notification', listener);
    raw.emit('notification', notification);

    expect(listener).toHaveBeenCalledWith(notification);
  });

  it('forwards raw end events to wrapper listeners', () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const listener = vi.fn();

    client.on('end', listener);
    raw.emit('end');

    expect(listener).toHaveBeenCalledOnce();
  });

  it('re-emits fatal raw errors on wrapper error listeners', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const fatalError = new Error('fatal');
    const listener = vi.fn();
    const queued = client.query('SELECT 1');

    client.on('error', listener);
    await flushMicrotasks();

    raw.emit('error', fatalError);

    expect(listener).toHaveBeenCalledWith(fatalError);
    await expect(queued).rejects.toBeInstanceOf(ClientBrokenError);
  });

  it('removes raw event forwarders after release', async () => {
    const raw = makeClient();
    const client = wrapClient(asPoolClient(raw));
    const notice = vi.fn();
    const notification = vi.fn();
    const end = vi.fn();

    client.on('notice', notice);
    client.on('notification', notification);
    client.on('end', end);

    client.release();
    await flushMicrotasks();

    raw.emit('notice');
    raw.emit('notification');
    raw.emit('end');

    expect(notice).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});
