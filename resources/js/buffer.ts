import type { TraceBugEvent } from './types';

const TTL = 180_000;
const BYTE_LIMIT = 48_000;
const important = (e: TraceBugEvent) => ['error', 'vue', 'console'].includes(e.type)
  || (e.type === 'network' && (e.data.slow === true || Number(e.data.status) >= 400
    || ['failed', 'timeout', 'cancelled', 'pending'].includes(String(e.data.state))));

/** Passive evidence has no storage adapter: it lives only in this instance. */
export class EventBuffer {
  private events: TraceBugEvent[] = [];

  constructor(_scope?: string) {}

  add(event: TraceBugEvent): void {
    this.events = this.events.filter(e => e.id !== event.id);
    this.events.push(event);
    this.trim();
  }

  snapshot(): TraceBugEvent[] {
    this.trim();
    return JSON.parse(JSON.stringify(this.events)) as TraceBugEvent[];
  }

  acknowledge(submitted: TraceBugEvent[]): void {
    const versions = new Map(submitted.map(e => [e.id, JSON.stringify(e)]));
    this.events = this.events.filter(e => versions.get(e.id) !== JSON.stringify(e));
    this.trim();
  }

  clear(): void { this.events = []; }

  private trim(): void {
    const now = Date.now();
    this.events = this.events.filter(e => e.at > now - TTL && e.at <= now + 1000);
    const critical = this.events.filter(important).slice(-50);
    const selected = new Set(critical.map(e => e.id));
    const rest = this.events.filter(e => !selected.has(e.id)).slice(-(50 - critical.length));
    this.events = [...critical, ...rest].sort((a, b) => a.at - b.at);
    while (new TextEncoder().encode(JSON.stringify(this.events)).length > BYTE_LIMIT && this.events.length) {
      const disposable = this.events.findIndex(e => !important(e));
      this.events.splice(disposable < 0 ? 0 : disposable, 1);
    }
  }
}
