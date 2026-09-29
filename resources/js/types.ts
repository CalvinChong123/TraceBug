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
  /** Advanced opt-in: also requires the server flag and CORS/header review. */
  correlateRequests?: boolean;
  /** Runs before any event enters the memory buffer. Return null to omit it. */
  redact?: (event: TraceBugEvent) => TraceBugEvent | null;
  sanitizeUrl?: (url: string) => string;
  /** Explicit additional first-party origins eligible for correlation headers. */
  correlationOrigins?: string[];
}

export type ScreenshotSource = 'browser' | 'upload' | 'paste';

export interface TraceBugReportInput {
  summary: string;
  steps?: string;
  expected?: string;
  actual?: string;
  screenshot?: Blob | null;
  screenshotSource?: ScreenshotSource;
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
  screenshot_enabled?: boolean;
  require_steps?: boolean;
  slow_request_ms?: number;
  correlation_headers_enabled?: boolean;
}

export interface TraceBugClient {
  report(input: TraceBugReportInput): Promise<string>;
  discard(): void;
  isActive(): boolean;
  onStop(listener: () => void): () => void;
  stop(): void;
  recordError(error: unknown, info?: string): void;
  policy: { screenshotsEnabled: boolean; requireSteps: boolean };
}
