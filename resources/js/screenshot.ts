import { safeLabel, safeUrl } from './privacy';

export interface RedactionRect { x: number; y: number; width: number; height: number }

const MAX_PIXELS = 4_000_000;
const MAX_BYTES = 2 * 1024 * 1024;

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('Screenshot is larger than 2 MB after compression.');
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const image = new Image();
  const url = URL.createObjectURL(blob);
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Cannot read screenshot image.'));
    });
    image.src = url;
    await loaded;
    return image;
  } finally { URL.revokeObjectURL(url); }
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  if (!width || !height) throw new Error('Screenshot has no visible image.');
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

/** Converts a pasted or uploaded browser screenshot to the same bounded format used by reports. */
export async function prepareScreenshot(blob: Blob): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error('Use a PNG, JPEG or WebP screenshot.');
  const image = await loadImage(blob);
  const canvas = canvasFor(image.naturalWidth, image.naturalHeight);
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  try { return await encode(canvas); }
  finally { canvas.width = canvas.height = 0; }
}

/** Rectangles use fractions of the preview width and height, so scaling stays accurate. */
export async function redactScreenshot(blob: Blob, rectangles: RedactionRect[]): Promise<Blob> {
  if (!rectangles.length) return blob;
  const image = await loadImage(blob);
  const canvas = canvasFor(image.naturalWidth, image.naturalHeight);
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.fillStyle = '#0f172a';
  for (const rect of rectangles) {
    context.fillRect(rect.x * canvas.width, rect.y * canvas.height, rect.width * canvas.width, rect.height * canvas.height);
  }
  try { return await encode(canvas); }
  finally { canvas.width = canvas.height = 0; }
}

/** Capture browser-rendered pixels after a user chooses a tab in the browser permission picker. */
export async function captureBrowserTab(selector: string, hideReportUi: (hidden: boolean) => void): Promise<Blob> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot capture a tab. Paste or upload a screenshot.');
  // This must be the first asynchronous operation after the capture button click.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include',
    monitorTypeSurfaces: 'exclude', surfaceSwitching: 'exclude',
  } as DisplayMediaStreamOptions);
  const video = document.createElement('video');
  try {
    const track = stream.getVideoTracks()[0];
    if (!track || (track.getSettings().displaySurface && track.getSettings().displaySurface !== 'browser')) {
      throw new Error('Choose this browser tab, not a window or desktop.');
    }
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    hideReportUi(true);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await Promise.race([
      new Promise<void>(resolve => video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => resolve()) : setTimeout(resolve, 180)),
      new Promise<void>(resolve => setTimeout(resolve, 900)),
    ]);
    const canvas = canvasFor(video.videoWidth, video.videoHeight);
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Mask form controls and app-marked private regions before any image is uploaded.
    const xScale = canvas.width / innerWidth;
    const yScale = canvas.height / innerHeight;
    context.fillStyle = '#0f172a';
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight) {
        context.fillRect(rect.left * xScale, rect.top * yScale, rect.width * xScale, rect.height * yScale);
      }
    }
    try { return await encode(canvas); }
    finally { canvas.width = canvas.height = 0; }
  } finally {
    hideReportUi(false);
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  }
}

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
