import { EventBuffer } from './buffer';
import { requestHeaders } from './core';
import { PRIVATE_SELECTOR, safeLabel, safeText, safeUrl } from './privacy';
import { capture, diagnose } from './screenshot';
import type { ServerConfig, TraceBugClient, TraceBugEvent, TraceBugOptions } from './types';

export function createRecorder(config: ServerConfig, options: TraceBugOptions): TraceBugClient {
  const buffer = new EventBuffer(config.scope);
  const originalFetch = window.fetch;
  const undo: (() => void)[] = [];
  let stopped = false;
  let uploading: Promise<string> | undefined;
  let pending: { payload: Record<string, unknown>; events: TraceBugEvent[]; screenshot?: Blob } | undefined;
  let captureRunning: Promise<Blob> | undefined;
  const selector = `${PRIVATE_SELECTOR}${options.privateSelector ? ',' + options.privateSelector : ''}`;
  // Validate custom selectors before installing any hooks.
  document.querySelector(selector);
  const url = (value: string) => {
    try { return safeUrl(options.sanitizeUrl?.(safeUrl(value)) ?? safeUrl(value)); }
    catch { return '[omitted]'; }
  };
  const own = (value: string) => {
    try {
      const target = new URL(value, location.href);
      const endpoint = new URL(config.endpoint);
      return target.origin === endpoint.origin && target.pathname.startsWith(endpoint.pathname.replace(/\/reports$/, '/'));
    } catch { return true; }
  };
  const correlate = (value: string) => {
    try { return [location.origin, ...(options.correlationOrigins ?? [])].includes(new URL(value, location.href).origin); }
    catch { return false; }
  };
  const add = (type: TraceBugEvent['type'], data: Record<string, unknown>, id: string = crypto.randomUUID(), at = Date.now()) => {
    if (stopped) return;
    try {
      const event = { id, at, type, data };
      const clean = options.redact ? options.redact(event) : event;
      if (clean) buffer.add(clean);
    } catch { /* Diagnostics must not throw into the application. */ }
  };
  const listen = (target: EventTarget, type: string, handler: EventListener, capture = false) => {
    target.addEventListener(type, handler, capture);
    undo.push(() => target.removeEventListener(type, handler, capture));
  };
  const errorData = (error: unknown, info?: string) => ({
    name: error instanceof Error ? safeText(error.name) : 'UnknownError',
    frames: error instanceof Error ? (error.stack ?? '').split('\n').slice(1, 9).flatMap(line => {
      const match = line.match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
      return match ? [{ url: url(match[1]), line: Number(match[2]), column: Number(match[3]) }] : [];
    }) : [],
    ...(options.captureMessages && error instanceof Error ? { message: safeText(error.message) } : {}),
    ...(info ? { info: safeText(info) } : {}),
  });

  const wrappedFetch: typeof fetch = async function (input, init) {
    if (stopped) return originalFetch.call(window, input, init);
    let metadata: { id: string; at: number; start: number; data: Record<string, unknown> } | undefined;
    let nextInit = init;
    try {
      const rawUrl = input instanceof Request ? input.url : String(input);
      if (!own(rawUrl)) {
        const id = crypto.randomUUID();
        const data: Record<string, unknown> = { method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), url: url(rawUrl), state: 'pending' };
        if (correlate(rawUrl) && (init?.mode ?? (input instanceof Request ? input.mode : undefined)) !== 'no-cors') {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          headers.set('X-TraceBug-ID', id);
          nextInit = { ...init, headers };
          data.client_id = id;
        }
        metadata = { id, at: Date.now(), start: performance.now(), data };
        add('network', data, id, metadata.at);
      }
    } catch { nextInit = init; }
    try {
      const response = await originalFetch.call(window, input, nextInit);
      if (metadata) {
        const m = metadata;
        add('network', { ...m.data, state: 'completed', status: response.status, duration_ms: Math.round(performance.now() - m.start), request_id: response.headers.get('X-Request-ID') }, m.id, m.at);
      }
      return response;
    } catch (error) {
      if (metadata) {
        const m = metadata;
        const name = error instanceof Error ? error.name : '';
        add('network', { ...m.data, state: name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'cancelled' : 'failed', duration_ms: Math.round(performance.now() - m.start) }, m.id, m.at);
      }
      throw error;
    }
  };
  window.fetch = wrappedFetch;
  undo.push(() => { if (window.fetch === wrappedFetch) window.fetch = originalFetch; });

  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; rawUrl: string }>();
  const wrappedOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
    const result = Reflect.apply(originalOpen, this, args);
    xhrMeta.set(this, { method: String(args[0]).toUpperCase(), rawUrl: String(args[1]) });
    return result;
  } as typeof proto.open;
  const wrappedSend: typeof proto.send = function (this: XMLHttpRequest, body) {
    const meta = xhrMeta.get(this);
    if (!meta || own(meta.rawUrl) || stopped) return originalSend.call(this, body);
    const id = crypto.randomUUID();
    const at = Date.now();
    const start = performance.now();
    const data: Record<string, unknown> = { method: meta.method, url: url(meta.rawUrl), state: 'pending' };
    if (correlate(meta.rawUrl)) {
      try { this.setRequestHeader('X-TraceBug-ID', id); data.client_id = id; } catch { /* no mutation when unsupported */ }
    }
    add('network', data, id, at);
    let state = 'completed';
    const fail = () => { state = 'failed'; };
    const timeout = () => { state = 'timeout'; };
    const abort = () => { state = 'cancelled'; };
    const cleanup = () => {
      this.removeEventListener('error', fail); this.removeEventListener('timeout', timeout);
      this.removeEventListener('abort', abort); this.removeEventListener('loadend', finish);
    };
    const finish = () => {
      try {
        add('network', { ...data, state, status: this.status, duration_ms: Math.round(performance.now() - start), request_id: this.getResponseHeader('X-Request-ID') }, id, at);
      } catch { /* Some browsers restrict response access. */ }
      cleanup();
    };
    this.addEventListener('error', fail); this.addEventListener('timeout', timeout);
    this.addEventListener('abort', abort); this.addEventListener('loadend', finish);
    try { return originalSend.call(this, body); }
    catch (error) { state = 'failed'; finish(); throw error; }
  };
  proto.open = wrappedOpen; proto.send = wrappedSend;
  undo.push(() => { if (proto.open === wrappedOpen) proto.open = originalOpen; if (proto.send === wrappedSend) proto.send = originalSend; });

  listen(window, 'error', event => {
    if (event instanceof ErrorEvent) add('error', { ...errorData(event.error), source_url: url(event.filename), line: event.lineno, column: event.colno });
    else if (event.target instanceof HTMLImageElement && !event.target.closest(selector)) add('error', { name: 'ImageLoadError', src: url(event.target.currentSrc || event.target.src) });
  }, true);
  listen(window, 'unhandledrejection', event => add('error', errorData((event as PromiseRejectionEvent).reason)));
  for (const type of ['click', 'submit'] as const) {
    listen(document, type, event => {
      const element = event.target instanceof Element ? event.target : null;
      if (!element || element.closest('[data-tracebug-ui]') || element.closest(selector)) return;
      const rect = element.getBoundingClientRect();
      add(type, { label: safeLabel(element, selector), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
    }, true);
  }
  const navigation = () => add('navigation', { url: url(location.href) });
  listen(window, 'popstate', navigation);
  listen(window, 'hashchange', navigation);
  // Inertia dispatches native events; no dependency or route interception needed.
  listen(document, 'inertia:navigate', navigation);
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name];
    const wrapper: typeof original = function (...args) {
      const result = original.apply(history, args);
      navigation();
      return result;
    };
    history[name] = wrapper;
    undo.push(() => { if (history[name] === wrapper) history[name] = original; });
  }
  if (options.captureConsole) {
    const original = console.error;
    const wrapper: typeof console.error = (...args) => {
      add('console', { name: 'ConsoleError', ...(options.captureMessages ? { message: safeText(args.filter(a => typeof a === 'string').join(' ')) } : {}) });
      original.apply(console, args);
    };
    console.error = wrapper;
    undo.push(() => { if (console.error === wrapper) console.error = original; });
  }
  navigation();

  const stop = () => {
    stopped = true;
    undo.reverse().forEach(fn => fn());
    buffer.clear();
    pending = undefined;
  };

  async function submit(): Promise<string> {
    if (stopped) throw new Error('TraceBug is stopped');
    const response = await originalFetch.call(window, options.configUrl ?? '/_tracebug/config', {
      credentials: options.credentials ?? 'same-origin', headers: requestHeaders(options), cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Cannot verify TraceBug access. Retry when connected.');
    const current = await response.json() as ServerConfig;
    if (!current.enabled || current.scope !== config.scope) {
      stop();
      throw new Error('TraceBug access changed. Reload the page.');
    }
    if (!pending) {
      const events = buffer.snapshot();
      const payload: Record<string, unknown> = {
        schema_version: 1, submission_id: crypto.randomUUID(), captured_at: new Date().toISOString(), events,
        page: { url: url(location.href), viewport: { width: innerWidth, height: innerHeight },
          screen: { width: screen.width, height: screen.height }, dpr: devicePixelRatio,
          orientation: screen.orientation?.type ?? (innerWidth > innerHeight ? 'landscape' : 'portrait'), user_agent: safeText(navigator.userAgent) },
        ui: diagnose(selector, url), screenshot_status: 'disabled',
      };
      pending = { payload, events };
      if (options.screenshot !== false) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // A timed-out canvas task cannot be cancelled; never start a second one alongside it.
          if (captureRunning) throw new Error('capture-busy');
          captureRunning = capture(selector);
          void captureRunning.then(() => { captureRunning = undefined; }, () => { captureRunning = undefined; });
          pending.screenshot = await Promise.race([captureRunning, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('capture-timeout')), 5000); })]);
          payload.screenshot_status = 'captured';
        } catch (error) { payload.screenshot_status = error instanceof Error && error.message === 'capture-timeout' ? 'timeout' : 'failed'; }
        finally { clearTimeout(timer); }
      }
    }
    if (stopped || !pending) throw new Error('TraceBug is stopped');
    const snapshot = pending;
    const form = new FormData();
    form.set('payload', JSON.stringify(snapshot.payload));
    if (snapshot.screenshot) form.set('screenshot', snapshot.screenshot, 'screenshot.' + (snapshot.screenshot.type === 'image/webp' ? 'webp' : 'png'));
    const upload = await originalFetch.call(window, config.endpoint, {
      method: 'POST', body: form, credentials: options.credentials ?? 'same-origin', headers: requestHeaders(options), signal: AbortSignal.timeout(20000),
    });
    if (upload.status === 401 || upload.status === 403 || upload.status === 404) {
      stop();
      throw new Error('TraceBug access changed. Reload the page.');
    }
    if (!upload.ok) throw new Error(`Report upload failed (${upload.status}). Retry when ready.`);
    const result = await upload.json();
    if (typeof result.report_id !== 'string') throw new Error('Invalid upload response. Retry when ready.');
    buffer.acknowledge(snapshot.events);
    pending = undefined;
    return result.report_id;
  }

  return {
    stop,
    recordError(error, info) { add('vue', errorData(error, info)); },
    report() {
      if (!uploading) uploading = submit().finally(() => { uploading = undefined; });
      return uploading;
    },
  };
}
