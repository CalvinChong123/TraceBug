import type { TraceBugEvent } from './types';

const PREFIX = 'tracebug:v1:';
const TTL = 180_000;
const BYTE_LIMIT = 48_000;
const important = (e: TraceBugEvent) => ['error', 'vue', 'console'].includes(e.type)
  || (e.type === 'network' && (Number(e.data.status) >= 400 || ['failed', 'timeout', 'cancelled', 'pending'].includes(String(e.data.state))));

export class EventBuffer {
  private events: TraceBugEvent[] = [];
  private key: string;

  constructor(scope: string) {
    this.key = PREFIX + scope;
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith(PREFIX) && key !== this.key) sessionStorage.removeItem(key);
      }
      const raw = sessionStorage.getItem(this.key);
      const parsed = raw && new TextEncoder().encode(raw).length <= BYTE_LIMIT ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) this.events = parsed.filter(e => e && typeof e.id === 'string' && typeof e.at === 'number' && typeof e.type === 'string' && e.data && typeof e.data === 'object');
    } catch { /* Memory-only fallback. */ }
    this.trim();
  }

  add(event: TraceBugEvent): void {
    this.events = this.events.filter(e => e.id !== event.id);
    this.events.push(event);
    this.trim();
  }

  snapshot(): TraceBugEvent[] {
    this.trim();
    return structuredClone(this.events);
  }

  acknowledge(submitted: TraceBugEvent[]): void {
    // Preserve network events which completed while this snapshot was uploading.
    const versions = new Map(submitted.map(e => [e.id, JSON.stringify(e)]));
    this.events = this.events.filter(e => versions.get(e.id) !== JSON.stringify(e));
    this.trim();
  }

  clear(): void {
    this.events = [];
    try { sessionStorage.removeItem(this.key); } catch { /* noop */ }
  }

  private trim(): void {
    const now = Date.now();
    this.events = this.events.filter(e => e.at > now - TTL && e.at <= now + 1000);
    // Reserve 20 positions for important evidence under normal-event pressure.
    const critical = this.events.filter(important).slice(-20);
    const selected = new Set(critical.map(e => e.id));
    const rest = this.events.filter(e => !selected.has(e.id)).slice(-(50 - critical.length));
    this.events = [...critical, ...rest].sort((a, b) => a.at - b.at);
    while (new TextEncoder().encode(JSON.stringify(this.events)).length > BYTE_LIMIT && this.events.length) this.events.shift();
    try { sessionStorage.setItem(this.key, JSON.stringify(this.events)); } catch { /* Memory remains usable. */ }
  }
}
