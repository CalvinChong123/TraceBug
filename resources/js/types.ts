export interface TraceBugOptions {
  configUrl?: string;
  /** Authentication/CSRF headers used only for TraceBug requests; never recorded. */
  headers?: () => Record<string, string>;
  credentials?: RequestCredentials;
  screenshot?: boolean;
  privateSelector?: string;
  /** Enable only after reviewing app messages for sensitive business data. */
  captureMessages?: boolean;
  captureConsole?: boolean;
  /** Runs before any event enters memory/sessionStorage. Return null to omit it. */
  redact?: (event: TraceBugEvent) => TraceBugEvent | null;
  sanitizeUrl?: (url: string) => string;
  /** Explicit additional first-party origins eligible for correlation headers. */
  correlationOrigins?: string[];
}

export interface TraceBugEvent {
  id: string;
  at: number;
  type: 'network' | 'error' | 'vue' | 'console' | 'navigation' | 'click' | 'submit';
  data: Record<string, unknown>;
}

export interface ServerConfig {
  enabled: boolean;
  scope: string;
  endpoint: string;
  release?: string;
}

export interface TraceBugClient {
  report(): Promise<string>;
  stop(): void;
  recordError(error: unknown, info?: string): void;
}
