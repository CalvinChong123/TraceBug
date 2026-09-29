export const PRIVATE_SELECTOR = '[data-tracebug-private], input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function safeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(password|token|secret|authorization|cookie|api[_-]?key|csrf)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[number]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[opaque]')
    .slice(0, 1000);
}

export function safeUrl(value: string): string {
  try {
    const url = new URL(value, location.href);
    if (!/^https?:$/.test(url.protocol)) return '[non-http]';
    const count = Math.min(12, url.pathname.split('/').filter(Boolean).length);
    return count ? '/' + Array(count).fill(':segment').join('/') : '/';
  } catch { return '[invalid-url]'; }
}

export function safeLabel(element: Element, selector = PRIVATE_SELECTOR): string {
  if (element.closest(selector)) return '[private]';
  // Never use innerText, IDs, field values or arbitrary accessibility labels.
  return element.tagName.toLowerCase();
}

export function browserFamily(userAgent: string): string {
  const match = userAgent.match(/(?:Edg|Firefox|Chrome|Version)\/([0-9]{1,3})/);
  const family = userAgent.includes('Edg/') ? 'Edge' : userAgent.includes('Firefox/') ? 'Firefox'
    : userAgent.includes('Chrome/') ? 'Chrome' : userAgent.includes('Safari/') ? 'Safari' : 'Other';
  return family + (match ? '/' + match[1] : '');
}
