import { EventBuffer } from './buffer';
import { requestHeaders } from './core';
import { PRIVATE_SELECTOR, browserFamily, safeLabel, safeText, safeUrl } from './privacy';
import { diagnose } from './screenshot';
import type { ServerConfig, TraceBugClient, TraceBugEvent, TraceBugOptions, TraceBugReportInput } from './types';

export function createRecorder(config: ServerConfig, options: TraceBugOptions, onStop?: () => void): TraceBugClient {
  if (typeof window.fetch !== 'function' || !globalThis.crypto?.getRandomValues) throw new Error('Required browser APIs unavailable');
  const uuid = () => {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  uuid(); // Fail before installing any hook.
  const buffer = new EventBuffer(config.scope);
  const originalFetch = window.fetch;
  const undo: (() => void)[] = [];
  const stopListeners = new Set<() => void>();
  let stopped = false;
  let uploading: Promise<string> | undefined;
  let pending: { payload: Record<string, unknown>; events: TraceBugEvent[]; screenshot?: Blob } | undefined;
  const slowMs = Number.isFinite(config.slow_request_ms) ? Math.max(1, Number(config.slow_request_ms)) : 1500;
  const injectHeader = options.correlateRequests === true && config.correlation_headers_enabled === true;
  const method = (value: string) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(value.toUpperCase()) ? value.toUpperCase() : 'OTHER';
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
  const add = (type: TraceBugEvent['type'], data: Record<string, unknown>, id?: string, at = Date.now()) => {
    if (stopped) return;
    try {
      const event = { id: id ?? uuid(), at, type, data };
      const clean = options.redact ? options.redact(event) : event;
      if (clean) buffer.add(clean);
    } catch { /* Diagnostics must not throw into the application. */ }
  };
  const resourceEvents = () => {
    try {
      return (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .filter(entry => entry.name && !own(entry.name) && !['fetch', 'xmlhttprequest'].includes(entry.initiatorType))
        .slice(-30)
        .map((entry, index) => {
          const data: Record<string, unknown> = {
            method: 'GET',
            url: url(entry.name),
            state: 'completed',
            initiator_type: ['img', 'script', 'link', 'css', 'iframe'].includes(entry.initiatorType) ? entry.initiatorType : 'other',
            duration_ms: Math.round(entry.duration),
            slow: entry.duration >= slowMs,
          };
          if (entry.transferSize > 0) data.transfer_size = entry.transferSize;
          return {
            id: `resource-${Math.round(entry.startTime)}-${index}`,
            at: Math.round(performance.timeOrigin + entry.startTime),
            type: 'network' as const,
            data,
          };
        });
    } catch { return []; }
  };
  const reportEvents = () => {
    const current = buffer.snapshot();
    const seen = new Set(current.filter(event => event.type === 'network').map(event => String(event.data.url) + ':' + String(event.data.state)));
    const resources = resourceEvents().filter(event => !seen.has(String(event.data.url) + ':' + String(event.data.state)));
    const merged = [...current, ...resources].sort((a, b) => a.at - b.at);
    if (merged.length <= 50) return merged;
    const protectedIds = new Set(merged.filter(event => ['error', 'vue', 'console'].includes(event.type)
      || (event.type === 'network' && (event.data.slow === true || Number(event.data.status) >= 400
        || ['failed', 'timeout', 'cancelled'].includes(String(event.data.state))))).slice(-25).map(event => event.id));
    const selected: TraceBugEvent[] = merged.filter(event => protectedIds.has(event.id));
    for (const event of [...merged].reverse()) {
      if (selected.length >= 50) break;
      if (!protectedIds.has(event.id)) selected.push(event);
    }
    return selected.reverse().sort((a, b) => a.at - b.at);
  };
  const listen = (target: EventTarget, type: string, handler: EventListener, capture = false) => {
    target.addEventListener(type, handler, capture);
    undo.push(() => target.removeEventListener(type, handler, capture));
  };
  const errorData = (error: unknown, info?: string) => ({
    name: error instanceof Error && ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError'].includes(error.name) ? error.name : 'OtherError',
    frames: error instanceof Error ? (error.stack ?? '').split('\n').slice(1, 9).flatMap(line => {
      const match = line.match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
      return match ? [{ url: url(match[1]), line: Number(match[2]), column: Number(match[3]) }] : [];
    }) : [],
  });

  const wrappedFetch: typeof fetch = async function (input, init) {
    if (stopped) return originalFetch.call(window, input, init);
    let metadata: { id: string; at: number; start: number; data: Record<string, unknown> } | undefined;
    let nextInit = init;
    try {
      const rawUrl = input instanceof Request ? input.url : String(input);
      if (!own(rawUrl)) {
        const id = uuid();
        const data: Record<string, unknown> = { method: method(init?.method ?? (input instanceof Request ? input.method : 'GET')), url: url(rawUrl), state: 'pending' };
        if (injectHeader && correlate(rawUrl) && (init?.mode ?? (input instanceof Request ? input.mode : undefined)) !== 'no-cors') {
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
      if (metadata) try {
        const m = metadata;
        const duration = Math.round(performance.now() - m.start);
        add('network', { ...m.data, state: 'completed', status: response.status, duration_ms: duration, slow: duration >= slowMs, request_id: response.headers.get('X-Request-ID') }, m.id, m.at);
      } catch { /* Never turn a successful host request into a failure. */ }
      return response;
    } catch (error) {
      if (metadata) try {
        const m = metadata;
        const name = error instanceof Error ? error.name : '';
        const duration = Math.round(performance.now() - m.start);
        add('network', { ...m.data, state: name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'cancelled' : 'failed', duration_ms: duration, slow: duration >= slowMs }, m.id, m.at);
      } catch { /* Preserve the host request's original error. */ }
      throw error;
    }
  };
  try {
  window.fetch = wrappedFetch;
  undo.push(() => { if (window.fetch === wrappedFetch) window.fetch = originalFetch; });

  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; rawUrl: string }>();
  const wrappedOpen = function (this: XMLHttpRequest, ...args: unknown[]) {
    const result = Reflect.apply(originalOpen, this, args);
    try { xhrMeta.set(this, { method: method(String(args[0])), rawUrl: String(args[1]) }); }
    catch { /* Preserve the successful open call. */ }
    return result;
  } as typeof proto.open;
  const wrappedSend: typeof proto.send = function (this: XMLHttpRequest, body) {
    const meta = xhrMeta.get(this);
    if (!meta || own(meta.rawUrl) || stopped) return originalSend.call(this, body);
    let id: string;
    try { id = uuid(); } catch { return originalSend.call(this, body); }
    const at = Date.now();
    const start = performance.now();
    const data: Record<string, unknown> = { method: meta.method, url: url(meta.rawUrl), state: 'pending' };
    if (injectHeader && correlate(meta.rawUrl)) {
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
        const duration = Math.round(performance.now() - start);
        add('network', { ...data, state, status: this.status, duration_ms: duration, slow: duration >= slowMs, request_id: this.getResponseHeader('X-Request-ID') }, id, at);
      } catch { /* Some browsers restrict response access. */ }
      try { cleanup(); } catch { /* Preserve host event delivery. */ }
    };
    try {
      this.addEventListener('error', fail); this.addEventListener('timeout', timeout);
      this.addEventListener('abort', abort); this.addEventListener('loadend', finish);
    } catch { try { cleanup(); } catch { /* Continue the host request. */ } return originalSend.call(this, body); }
    try { return originalSend.call(this, body); }
    catch (error) { state = 'failed'; try { finish(); } catch { /* Preserve send error. */ } throw error; }
  };
  proto.open = wrappedOpen;
  undo.push(() => { if (proto.open === wrappedOpen) proto.open = originalOpen; });
  proto.send = wrappedSend;
  undo.push(() => { if (proto.send === wrappedSend) proto.send = originalSend; });

  listen(window, 'error', event => {
    if (event instanceof ErrorEvent) add('error', { ...errorData(event.error), source_url: url(event.filename), line: event.lineno, column: event.colno });
    else if (event.target instanceof HTMLImageElement && !event.target.closest(selector)) add('error', { name: 'ImageLoadError', source_url: url(event.target.currentSrc || event.target.src) });
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
  if (options.captureConsole !== false) {
    const original = console.error;
    const wrapper: typeof console.error = (...args) => {
      add('console', { name: 'ConsoleError' });
      original.apply(console, args);
    };
    console.error = wrapper;
    undo.push(() => { if (console.error === wrapper) console.error = original; });
  }
  navigation();
  } catch (error) {
    undo.reverse().forEach(fn => { try { fn(); } catch { /* Continue restoring. */ } });
    buffer.clear();
    throw error;
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    undo.reverse().forEach(fn => { try { fn(); } catch { /* Continue restoring. */ } });
    buffer.clear();
    pending = undefined;
    try { onStop?.(); } catch { /* Continue cleaning up integrations. */ }
    for (const listener of stopListeners) { try { listener(); } catch { /* Ignore integration cleanup errors. */ } }
    stopListeners.clear();
  };

  async function submit(input: TraceBugReportInput): Promise<string> {
    if (stopped) throw new Error('TraceBug is stopped');
    if (!input.summary?.trim() || input.summary.trim().length < 3) throw new Error('Add a problem summary of at least 3 characters.');
    if (config.require_steps !== false && !input.steps?.trim()) throw new Error('Add steps to reproduce before submitting.');
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
      const events = reportEvents();
      const payload: Record<string, unknown> = {
        schema_version: 1, submission_id: uuid(), captured_at: new Date().toISOString(), events,
        page: { url: url(location.href), viewport: { width: innerWidth, height: innerHeight },
          screen: { width: screen.width, height: screen.height }, dpr: devicePixelRatio,
          orientation: screen.orientation?.type ?? (innerWidth > innerHeight ? 'landscape' : 'portrait'), user_agent: browserFamily(navigator.userAgent) },
        ui: diagnose(selector, url), screenshot_status: 'disabled', screenshot_source: 'none',
        qa: {
          summary: safeText(input.summary.trim()).slice(0, 500),
          ...(input.steps?.trim() ? { steps: safeText(input.steps.trim()) } : {}),
          ...(input.expected?.trim() ? { expected: safeText(input.expected.trim()) } : {}),
          ...(input.actual?.trim() ? { actual: safeText(input.actual.trim()) } : {}),
        },
      };
      pending = { payload, events };
      if (input.screenshot) {
        if (config.screenshot_enabled !== true) { pending = undefined; throw new Error('Screenshots are disabled by the server.'); }
        if (!['image/png', 'image/webp', 'image/jpeg'].includes(input.screenshot.type) || input.screenshot.size > 2 * 1024 * 1024) {
          pending = undefined;
          throw new Error('Screenshot must be PNG, JPEG or WebP and at most 2 MB.');
        }
        pending.screenshot = input.screenshot;
        payload.screenshot_status = 'captured';
        payload.screenshot_source = input.screenshotSource ?? 'upload';
      }
    }
    if (stopped || !pending) throw new Error('TraceBug is stopped');
    const snapshot = pending;
    const form = new FormData();
    form.set('payload', JSON.stringify(snapshot.payload));
    if (snapshot.screenshot) form.set('screenshot', snapshot.screenshot, 'screenshot.' + (snapshot.screenshot.type === 'image/webp' ? 'webp' : 'png'));
    let upload: Response;
    try { upload = await originalFetch.call(window, config.endpoint, {
      method: 'POST', body: form, credentials: options.credentials ?? 'same-origin', headers: requestHeaders(options), signal: AbortSignal.timeout(20000),
    }); } catch {
      const error = new Error('Submission result unknown. Retry this report, or discard it knowing it may have been saved.');
      error.name = 'TraceBugOutcomeUnknownError';
      throw error;
    }
    if (upload.status === 401 || upload.status === 403 || upload.status === 404) {
      stop();
      throw new Error('TraceBug access changed. Reload the page.');
    }
    if (!upload.ok) throw new Error(`Report upload failed (${upload.status}). Retry when ready.`);
    const result = await upload.json();
    if (typeof result.report_id !== 'string') throw new Error('Invalid upload response. Retry when ready.');
    buffer.clear();
    pending = undefined;
    return result.report_id;
  }

  return {
    policy: { screenshotsEnabled: config.screenshot_enabled === true, requireSteps: config.require_steps !== false },
    isActive() { return !stopped; },
    onStop(listener) { stopListeners.add(listener); return () => { stopListeners.delete(listener); }; },
    stop,
    discard() { pending = undefined; buffer.clear(); },
    recordError(error, info) { add('vue', errorData(error, info)); },
    report(input) {
      if (!uploading) uploading = submit(input).finally(() => { uploading = undefined; });
      return uploading;
    },
  };
}
