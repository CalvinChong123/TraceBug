import type { TraceBugClient, TraceBugOptions, ServerConfig } from './types';
export type { TraceBugClient, TraceBugOptions, TraceBugEvent } from './types';

export function requestHeaders(options: TraceBugOptions): Record<string, string> {
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
  return { Accept: 'application/json', ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}), ...options.headers?.() };
}

let active: TraceBugClient | undefined;
let starting: Promise<TraceBugClient | null> | undefined;

/** Call only when the server renders an eligible-user flag. Disabled users load no recorder. */
export async function startTraceBug(options: TraceBugOptions = {}): Promise<TraceBugClient | null> {
  if (typeof window === 'undefined') return null;
  if (active) return active;
  if (starting) return starting;
  starting = (async () => {
    try {
      const configUrl = new URL(options.configUrl ?? '/_tracebug/config', location.href);
      const response = await fetch(configUrl, {
        headers: requestHeaders(options), credentials: options.credentials ?? 'same-origin',
        cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      const config = await response.json() as ServerConfig;
      if (!config.enabled || typeof config.scope !== 'string' || typeof config.endpoint !== 'string') return null;
      config.endpoint = new URL(config.endpoint, configUrl).href;
      const { createRecorder } = await import('./recorder');
      const recorder = createRecorder(config, options);
      active = { ...recorder, stop() { recorder.stop(); active = undefined; } };
      return active;
    } catch { return null; }
    finally { starting = undefined; }
  })();
  return starting;
}
