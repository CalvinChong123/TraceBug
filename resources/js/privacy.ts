export const PRIVATE_SELECTOR = '[data-tracebug-private], input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function safeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(password|token|secret|authorization|cookie|api[_-]?key|csrf)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b\d{12,19}\b/g, '[number]')
    .slice(0, 1000);
}

export function safeUrl(value: string): string {
  try {
    const url = new URL(value, location.href);
    if (!/^https?:$/.test(url.protocol)) return '[non-http]';
    return safeText(url.pathname.replace(/\/(?:\d+|[a-zA-Z0-9_-]{24,})(?=\/|$)/g, '/:id'));
  } catch { return '[invalid-url]'; }
}

export function safeLabel(element: Element, selector = PRIVATE_SELECTOR): string {
  if (element.closest(selector)) return '[private]';
  // Never use innerText, IDs, field values or arbitrary accessibility labels.
  return safeText(element.closest('[data-tracebug-label]')?.getAttribute('data-tracebug-label') ?? element.tagName.toLowerCase());
}
