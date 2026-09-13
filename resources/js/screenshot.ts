import { PRIVATE_SELECTOR, safeLabel, safeUrl } from './privacy';

export function diagnose(selector: string, url: (value: string) => string) {
  const width = innerWidth;
  const overflow: unknown[] = [];
  const images: unknown[] = [];
  let scanned = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode() && scanned < 2000) {
    scanned++;
    const element = walker.currentNode as Element;
    if (element.closest(selector) || element.closest('[data-tracebug-ui]')) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > innerHeight) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if ((rect.left < -1 || rect.right > width + 1) && overflow.length < 20) {
      overflow.push({ label: safeLabel(element, selector), x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    if (element instanceof HTMLImageElement && images.length < 30 && element.complete && element.naturalWidth === 0) {
      images.push({ src: url(element.currentSrc || element.src), width: rect.width, height: rect.height, natural_width: element.naturalWidth, natural_height: element.naturalHeight });
    }
  }
  return { viewport_width: width, document_width: document.documentElement.scrollWidth,
    horizontal_overflow: document.documentElement.scrollWidth > width + 1,
    overflow_candidates: overflow, broken_images: images, scanned_elements: scanned, scan_truncated: scanned >= 2000 };
}

export async function capture(selector = PRIVATE_SELECTOR): Promise<Blob> {
  const { default: html2canvas } = await import('html2canvas');
  const canvas = await html2canvas(document.body, {
    width: innerWidth, height: innerHeight, x: scrollX, y: scrollY,
    windowWidth: innerWidth, windowHeight: innerHeight,
    scale: Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(4_000_000 / Math.max(1, innerWidth * innerHeight))),
    useCORS: true, allowTaint: false, logging: false, imageTimeout: 2000,
    backgroundColor: getComputedStyle(document.body).backgroundColor || null,
    ignoreElements: element => element.hasAttribute('data-tracebug-ui'),
    onclone: clone => {
      for (const element of clone.querySelectorAll('[data-tracebug-ui]')) element.remove();
      // Modify the clone only. Replace sensitive regions with opaque placeholders.
      for (const element of clone.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        const placeholder = clone.createElement('span');
        placeholder.style.cssText = `display:inline-block!important;width:${rect.width}px!important;height:${rect.height}px!important;background:#64748b!important;color:transparent!important;overflow:hidden!important;`;
        element.replaceWith(placeholder);
      }
    },
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      canvas.width = canvas.height = 0;
      if (blob && blob.size <= 2 * 1024 * 1024) resolve(blob);
      else reject(new Error('Screenshot unavailable or too large'));
    }, 'image/webp', 0.75);
  });
}
