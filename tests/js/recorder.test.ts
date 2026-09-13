// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBuffer } from '../../resources/js/buffer';
import { safeLabel, safeUrl } from '../../resources/js/privacy';
import { createRecorder } from '../../resources/js/recorder';
import type { TraceBugClient, TraceBugEvent } from '../../resources/js/types';

vi.mock('../../resources/js/screenshot', () => ({ capture: vi.fn().mockRejectedValue(new Error('canvas unavailable')), diagnose: () => ({ horizontal_overflow: true }) }));

const config = { enabled: true, scope: 'test-user', endpoint: 'http://localhost:3000/_tracebug/reports' };
let client: TraceBugClient | undefined;
let nativeFetch: typeof fetch;
const e = (id: string, type: TraceBugEvent['type'] = 'click', data = {}) => ({ id, at: Date.now(), type, data });

beforeEach(() => { sessionStorage.clear(); nativeFetch = window.fetch; });
afterEach(() => { client?.stop(); client = undefined; window.fetch = nativeFetch; vi.restoreAllMocks(); });

describe('bounded private context', () => {
  it('expires old events and reserves error evidence under normal traffic', () => {
    const buffer = new EventBuffer('a');
    buffer.add({ ...e('expired'), at: Date.now() - 180001 });
    buffer.add(e('error', 'error', { name: 'Error' }));
    for (let i = 0; i < 100; i++) buffer.add(e(String(i)));
    expect(buffer.snapshot()).toHaveLength(50);
    expect(buffer.snapshot().some(e => e.id === 'error')).toBe(true);
    expect(buffer.snapshot().some(e => e.id === 'expired')).toBe(false);
  });
  it('acknowledges only submitted versions and retains events added during upload', () => {
    const buffer = new EventBuffer('a');
    buffer.add(e('request', 'network', { state: 'pending' }));
    const snapshot = buffer.snapshot();
    buffer.add(e('request', 'network', { state: 'completed' }));
    buffer.add(e('new'));
    buffer.acknowledge(snapshot);
    expect(buffer.snapshot()).toHaveLength(2);
  });
  it('clears previous user data and survives unavailable sessionStorage', () => {
    new EventBuffer('old').add(e('private-old'));
    expect(new EventBuffer('new').snapshot()).toEqual([]);
    expect(sessionStorage.getItem('tracebug:v1:old')).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const buffer = new EventBuffer('memory');
    buffer.add(e('still-works'));
    expect(buffer.snapshot()).toHaveLength(1);
  });
  it('does not capture URL secrets or arbitrary element text', () => {
    expect(safeUrl('https://example.com/orders/123?token=secret#private')).toBe('/orders/:id');
    const button = document.createElement('button');
    button.textContent = 'Delete alice@example.com';
    expect(safeLabel(button)).toBe('button');
    button.setAttribute('data-tracebug-label', 'Delete order');
    expect(safeLabel(button)).toBe('Delete order');
    button.setAttribute('data-tracebug-private', '');
    expect(safeLabel(button)).toBe('[private]');
  });
});

describe('recording and submission', () => {
  it('preserves fetch responses, records failures, and never reads bodies', async () => {
    const response = new Response('private response', { status: 500, headers: { 'X-Request-ID': 'server-id' } });
    const text = vi.spyOn(response, 'text');
    const fetch = vi.fn().mockResolvedValue(response);
    window.fetch = fetch;
    client = createRecorder(config, { screenshot: false });
    expect(await window.fetch('/api/save?token=secret', { method: 'POST', body: 'password=secret' })).toBe(response);
    expect(text).not.toHaveBeenCalled();
    const events = new EventBuffer(config.scope).snapshot();
    expect(events.find(e => e.type === 'network')?.data).toMatchObject({ status: 500, url: '/api/save' });
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(new Headers(fetch.mock.calls[0][1].headers).get('X-TraceBug-ID')).toBeTruthy();
  });
  it('does not inject correlation headers into third-party requests', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok'));
    window.fetch = fetch;
    client = createRecorder(config, {});
    await window.fetch('https://external.example/resource');
    expect(fetch.mock.calls[0][1]).toBeUndefined();
  });
  it('rethrows the same fetch error and leaves diagnostic evidence', async () => {
    const error = new TypeError('Failed to fetch');
    window.fetch = vi.fn().mockRejectedValue(error);
    client = createRecorder(config, {});
    await expect(window.fetch('/api/save')).rejects.toBe(error);
    expect(new EventBuffer(config.scope).snapshot().find(e => e.type === 'network')?.data.state).toBe('failed');
  });
  it('keeps useful stack locations without exception messages or source URL secrets', () => {
    window.fetch = vi.fn();
    client = createRecorder(config, {});
    const error = new Error('password=hunter2');
    error.stack = 'Error: password=hunter2\n at save (https://example.com/assets/app.js?token=secret:10:20)';
    client.recordError(error, 'component event handler');
    const event = new EventBuffer(config.scope).snapshot().find(e => e.type === 'vue');
    expect(event?.data.frames).toEqual([{ url: '/assets/app.js', line: 10, column: 20 }]);
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(JSON.stringify(event)).not.toContain('hunter2');
  });
  it('retries the exact frozen submission and preserves new events', async () => {
    const uploads: FormData[] = [];
    let attempt = 0;
    window.fetch = vi.fn(async (_input, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      uploads.push(init.body as FormData);
      return ++attempt === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ report_id: 'TB-test' }));
    });
    client = createRecorder(config, { screenshot: false });
    client.recordError(new Error('before'));
    await expect(client.report()).rejects.toThrow('503');
    client.recordError(new Error('during'));
    await expect(client.report()).resolves.toBe('TB-test');
    expect(uploads[0].get('payload')).toBe(uploads[1].get('payload'));
    expect(new EventBuffer(config.scope).snapshot()).toHaveLength(1);
  });
  it('uploads remaining evidence if screenshot capture fails', async () => {
    let payload: any;
    window.fetch = vi.fn(async (_input, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      payload = JSON.parse(String((init.body as FormData).get('payload')));
      return new Response(JSON.stringify({ report_id: 'TB-test' }));
    });
    client = createRecorder(config, {});
    await client.report();
    expect(payload.screenshot_status).toBe('failed');
    expect(payload.ui.horizontal_overflow).toBe(true);
  });
  it('includes browser resource timings in network evidence', async () => {
    let payload: any;
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: 'http://localhost:3000/storage/banner/abc.jpg?token=secret', initiatorType: 'img', startTime: 10, duration: 25.4, transferSize: 1234 },
      { name: 'http://localhost:3000/_tracebug/config', initiatorType: 'fetch', startTime: 15, duration: 3, transferSize: 200 },
    ] as PerformanceResourceTiming[]);
    window.fetch = vi.fn(async (_input, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      payload = JSON.parse(String((init.body as FormData).get('payload')));
      return new Response(JSON.stringify({ report_id: 'TB-test' }));
    });
    client = createRecorder(config, { screenshot: false });
    await client.report();
    expect(payload.events).toContainEqual(expect.objectContaining({
      type: 'network',
      data: expect.objectContaining({ url: '/storage/banner/abc.jpg', initiator_type: 'img', transfer_size: 1234 }),
    }));
    expect(JSON.stringify(payload.events)).not.toContain('secret');
  });
  it('clears context and prevents upload after an account change', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...config, scope: 'other-user' })));
    window.fetch = fetch;
    client = createRecorder(config, {});
    await expect(client.report()).rejects.toThrow('access changed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('tracebug:v1:test-user')).toBeNull();
  });
});
