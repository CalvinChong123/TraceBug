// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBuffer } from '../../resources/js/buffer';
import { startTraceBug } from '../../resources/js/core';
import { safeLabel, safeUrl } from '../../resources/js/privacy';
import { createRecorder } from '../../resources/js/recorder';
import type { TraceBugClient, TraceBugEvent } from '../../resources/js/types';

vi.mock('../../resources/js/screenshot', () => ({ diagnose: () => ({ horizontal_overflow: true }) }));

const config = { enabled: true, scope: 'test-user', endpoint: 'http://localhost:3000/_tracebug/reports',
  require_steps: true, screenshot_enabled: false, slow_request_ms: 1, correlation_headers_enabled: false };
let client: TraceBugClient | undefined;
let nativeFetch: typeof fetch;
const event = (id: string, type: TraceBugEvent['type'] = 'click', data = {}) => ({ id, at: Date.now(), type, data });
const input = { summary: 'Save failed', steps: 'Open the order and click Save' };

beforeEach(() => { sessionStorage.clear(); nativeFetch = window.fetch; });
afterEach(() => { client?.stop(); client = undefined; window.fetch = nativeFetch; vi.restoreAllMocks(); });

describe('memory and privacy', () => {
  it('never writes passive events to browser storage and prioritizes failures', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const buffer = new EventBuffer('scope');
    buffer.add(event('failed', 'network', { state: 'failed' }));
    for (let i = 0; i < 100; i++) buffer.add(event(String(i)));
    expect(buffer.snapshot()).toHaveLength(50);
    expect(buffer.snapshot().some(e => e.id === 'failed')).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(new EventBuffer('scope').snapshot()).toEqual([]);
    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
  });

  it('preserves slow requests when the byte limit removes newer routine events', () => {
    const buffer = new EventBuffer('scope');
    buffer.add(event('slow', 'network', { state: 'completed', slow: true, url: 'x'.repeat(20_000) }));
    for (let i = 0; i < 30; i++) buffer.add(event(String(i), 'click', { label: 'x'.repeat(2000) }));
    expect(buffer.snapshot().some(e => e.id === 'slow')).toBe(true);
  });

  it('removes values from URLs and ignores arbitrary labels', () => {
    expect(safeUrl('https://example.com/reset/shortToken?secret=x#private')).toBe('/:segment/:segment');
    const button = document.createElement('button');
    button.textContent = 'alice@example.com';
    button.setAttribute('data-tracebug-label', 'password=hunter2');
    expect(safeLabel(button)).toBe('button');
  });
});

describe('non-interfering recorder', () => {
  it('records failed/slow metadata without modifying the request or reading bodies', async () => {
    const response = new Response('private body', { status: 500 });
    const bodyRead = vi.spyOn(response, 'text');
    const fetch = vi.fn().mockResolvedValue(response);
    window.fetch = fetch;
    client = createRecorder(config, {});
    await window.fetch('/api/save?token=secret', { method: 'POST', body: 'password=secret' });
    expect(fetch.mock.calls[0][1]).toEqual({ method: 'POST', body: 'password=secret' });
    expect(bodyRead).not.toHaveBeenCalled();
    let payload: any;
    fetch.mockImplementation(async (_url, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      payload = JSON.parse(String((init.body as FormData).get('payload')));
      return new Response(JSON.stringify({ report_id: 'TB-test' }));
    });
    // The mock above returns on the report POST; first verify evidence remained in memory.
    await client.report(input);
    expect(payload.events).toContainEqual(expect.objectContaining({ type: 'network',
      data: expect.objectContaining({ status: 500, url: '/:segment/:segment' }) }));
    expect(JSON.stringify(payload)).not.toContain('password=secret');
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps a successful fetch successful when response metadata is unreadable', async () => {
    const response = new Response('ok');
    vi.spyOn(response.headers, 'get').mockImplementation(() => { throw new Error('blocked header'); });
    window.fetch = vi.fn(async () => response);
    client = createRecorder(config, {});
    expect(await window.fetch('/api/data')).toBe(response);
  });

  it('records image load errors using the accepted source_url field', async () => {
    let payload: any;
    window.fetch = vi.fn(async (_url, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      payload = JSON.parse(String((init.body as FormData).get('payload')));
      return new Response(JSON.stringify({ report_id: 'TB-test' }));
    });
    client = createRecorder(config, {});
    const image = document.createElement('img');
    image.src = 'https://assets.example.test/private.png?token=secret';
    document.body.append(image);
    image.dispatchEvent(new Event('error'));
    await client.report(input);
    expect(payload.events).toContainEqual(expect.objectContaining({ type: 'error',
      data: expect.objectContaining({ name: 'ImageLoadError', source_url: '/:segment' }) }));
    image.remove();
  });

  it('never records console arguments, even with legacy message opt-in', async () => {
    let payload: any;
    window.fetch = vi.fn(async (_url, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      payload = JSON.parse(String((init.body as FormData).get('payload')));
      return new Response(JSON.stringify({ report_id: 'TB-test' }));
    });
    client = createRecorder(config, { captureMessages: true });
    console.error('password=hunter2');
    await client.report(input);
    expect(payload.events.find((e: any) => e.type === 'console').data).toEqual({ name: 'ConsoleError' });
    expect(JSON.stringify(payload)).not.toContain('hunter2');
  });

  it('keeps a failed API request when newer resource timings crowd the report', async () => {
    let payload: any;
    const fetch = vi.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        payload = JSON.parse(String((init.body as FormData).get('payload')));
        return new Response(JSON.stringify({ report_id: 'TB-test' }));
      }
      return new Response(JSON.stringify(config));
    });
    window.fetch = fetch;
    client = createRecorder(config, {});
    for (let i = 0; i < 49; i++) await window.fetch('/ok/' + i);
    fetch.mockImplementationOnce(async () => new Response('', { status: 500 }));
    await window.fetch('/failed');
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(Array.from({ length: 30 }, (_, i) => ({
      name: 'https://assets.example.test/image/' + i, initiatorType: 'img', startTime: performance.now() + i + 1,
      duration: 10, transferSize: 500,
    })) as PerformanceResourceTiming[]);
    await client.report(input);
    expect(payload.events.some((e: any) => e.type === 'network' && e.data.status === 500)).toBe(true);
  });

  it('requires steps and honors the server screenshot policy', async () => {
    window.fetch = vi.fn(async () => new Response(JSON.stringify(config)));
    client = createRecorder(config, {});
    await expect(client.report({ summary: 'Save failed' })).rejects.toThrow('steps');
    await expect(client.report({ ...input, screenshot: new Blob(['x'], { type: 'image/png' }) })).rejects.toThrow('disabled');
    expect(client.policy).toEqual({ screenshotsEnabled: false, requireSteps: true });
  });

  it('retries frozen evidence and discards it when asked', async () => {
    const uploads: string[] = [];
    let attempts = 0;
    window.fetch = vi.fn(async (_url, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      uploads.push(String((init.body as FormData).get('payload')));
      return ++attempts === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ report_id: 'TB-test' }));
    });
    client = createRecorder(config, {});
    await expect(client.report(input)).rejects.toThrow('503');
    await client.report({ ...input, summary: 'Different' });
    expect(uploads[0]).toBe(uploads[1]);
    client.discard();
    await client.report({ ...input, summary: 'Fresh' });
    expect(JSON.parse(uploads[2]).qa.summary).toBe('Fresh');
  });

  it('labels a failed upload transport as an unknown result', async () => {
    window.fetch = vi.fn(async (_url, init) => {
      if (init?.method !== 'POST') return new Response(JSON.stringify(config));
      throw new TypeError('Failed to fetch');
    });
    client = createRecorder(config, {});
    await expect(client.report(input)).rejects.toMatchObject({ name: 'TraceBugOutcomeUnknownError' });
  });

  it('rolls back all hooks if startup fails after patching globals', () => {
    window.fetch = vi.fn();
    const fetch = window.fetch;
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const push = history.pushState;
    Object.defineProperty(history, 'pushState', { configurable: true, writable: false, value: push });
    try { expect(() => createRecorder(config, {})).toThrow(); }
    finally { Object.defineProperty(history, 'pushState', { configurable: true, writable: true, value: push }); }
    expect(window.fetch).toBe(fetch);
    expect(XMLHttpRequest.prototype.open).toBe(open);
    expect(XMLHttpRequest.prototype.send).toBe(send);
  });

  it('restores fetch and XHR open when XHR send cannot be patched', () => {
    window.fetch = vi.fn();
    const fetch = window.fetch;
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send')!;
    Object.defineProperty(XMLHttpRequest.prototype, 'send', { ...descriptor, writable: false });
    try { expect(() => createRecorder(config, {})).toThrow(); }
    finally { Object.defineProperty(XMLHttpRequest.prototype, 'send', descriptor); }
    expect(window.fetch).toBe(fetch);
    expect(XMLHttpRequest.prototype.open).toBe(open);
    expect(XMLHttpRequest.prototype.send).toBe(send);
  });

  it('clears the global active client after an access change', async () => {
    let scope = 'first';
    window.fetch = vi.fn(async () => new Response(JSON.stringify({ ...config, scope })));
    const first = await startTraceBug();
    scope = 'second';
    await expect(first!.report(input)).rejects.toThrow('access changed');
    expect(first!.isActive()).toBe(false);
    const second = await startTraceBug();
    expect(second).not.toBe(first);
    second?.stop();
  });
});
