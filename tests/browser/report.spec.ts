import { test, expect } from '@playwright/test';

test('QA summary and diagnostic evidence are submitted without a screenshot', async ({ page }, testInfo) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'browser-fixture', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: false } }));
  await page.route('**/api/save**', route => route.fulfill({ status: 500, headers: { 'X-Request-ID': 'bcf05176-4f4f-46fc-8977-72faeb02f460' }, json: { error: 'fixture' } }));
  await page.route('**/missing-fixture-image.png', route => route.fulfill({ status: 404, body: '' }));
  let uploaded: Buffer | null = null;
  await page.route('**/_tracebug/reports', async route => {
    uploaded = route.request().postDataBuffer();
    await route.fulfill({ status: 201, json: { report_id: 'TB-BROWSER-VERIFIED' } });
  });
  await page.goto('/tests/browser/fixture.html');
  await expect(page.getByRole('button', { name: 'Report bug' })).toBeVisible();
  await page.getByRole('button', { name: 'Save fixture', exact: true }).click();
  await page.getByRole('button', { name: 'XHR fixture', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);

  await page.getByRole('button', { name: 'Report bug' }).click();
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('Order save returned an error');
  await page.getByRole('textbox', { name: 'Steps to reproduce *' }).fill('Open fixture and click Save');
  await page.screenshot({ path: testInfo.outputPath('report-dialog.png') });
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByRole('status')).toContainText('TB-BROWSER-VERIFIED', { timeout: 15000 });
  const body = uploaded!.toString('utf8');
  expect(body).toContain('"screenshot_status":"disabled"');
  expect(body).toContain('"screenshot_source":"none"');
  expect(body).toContain('Order save returned an error');
  expect(body).toContain('"horizontal_overflow":true');
  expect(body).toContain('"status":500');
  expect(body).not.toContain('password=secret');
  expect(body).not.toContain('token=secret');
  expect(body).not.toContain('sensitive-password');
  expect(body).not.toContain('name="screenshot"');
});

test('native tab pixels are previewed, redacted and uploaded only after review', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Mobile WebKit does not expose tab capture in this fixture.');
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'native-fixture', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: true } }));
  let uploaded: Buffer | null = null;
  await page.route('**/_tracebug/reports', async route => {
    uploaded = route.request().postDataBuffer();
    await route.fulfill({ status: 201, json: { report_id: 'TB-NATIVE-VERIFIED' } });
  });
  await page.goto('/tests/browser/fixture.html');
  const privatePoint = await page.locator('[data-tracebug-private]').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: (rect.left + rect.width / 2) / innerWidth, y: (rect.top + rect.height / 2) / innerHeight };
  });
  const inputPoint = await page.locator('input').first().evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: (rect.left + rect.width / 2) / innerWidth, y: (rect.top + rect.height / 2) / innerHeight };
  });
  const embedded = await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:180px;top:90px;width:110px;height:70px';
    document.body.append(iframe);
    const host = document.createElement('private-widget');
    host.style.cssText = 'position:fixed;left:310px;top:90px;width:110px;height:70px;display:block';
    host.attachShadow({ mode: 'open' }).innerHTML = '<span>private shadow text</span>';
    document.body.append(host);
    const point = (element: Element) => { const rect = element.getBoundingClientRect(); return { x: (rect.left + rect.width / 2) / innerWidth, y: (rect.top + rect.height / 2) / innerHeight }; };
    return { iframePoint: point(iframe), shadowPoint: point(host) };
  });
  await page.evaluate(() => {
    const media = navigator.mediaDevices;
    Object.defineProperty(media, 'getDisplayMedia', { configurable: true, value: () => {
      const canvas = document.createElement('canvas');
      canvas.width = innerWidth; canvas.height = innerHeight;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#13ac62'; context.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(30);
      Object.defineProperty(stream.getVideoTracks()[0], 'getSettings', { value: () => ({ displaySurface: 'browser' }) });
      return Promise.resolve(stream);
    } });
  });
  await page.getByRole('button', { name: 'Report bug' }).click();
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('Native screenshot check');
  await page.getByRole('textbox', { name: 'Steps to reproduce *' }).fill('Open fixture and capture');
  await page.getByRole('button', { name: 'Capture this tab' }).click();
  const image = page.getByAltText('Screenshot preview');
  await expect(image).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save report' })).toBeDisabled();
  const colors = await image.evaluate(async (element: HTMLImageElement, points) => {
    await element.decode();
    const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0);
    return {
      clear: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3),
      private: [...context.getImageData(Math.round(canvas.width * points.privatePoint.x), Math.round(canvas.height * points.privatePoint.y), 1, 1).data].slice(0, 3),
      input: [...context.getImageData(Math.round(canvas.width * points.inputPoint.x), Math.round(canvas.height * points.inputPoint.y), 1, 1).data].slice(0, 3),
      iframe: [...context.getImageData(Math.round(canvas.width * points.iframePoint.x), Math.round(canvas.height * points.iframePoint.y), 1, 1).data].slice(0, 3),
      shadow: [...context.getImageData(Math.round(canvas.width * points.shadowPoint.x), Math.round(canvas.height * points.shadowPoint.y), 1, 1).data].slice(0, 3),
    };
  }, { privatePoint, inputPoint, ...embedded });
  expect(colors.clear[0]).toBeLessThan(50);
  expect(colors.clear[1]).toBeGreaterThan(130);
  expect(colors.private.every(value => value < 50)).toBe(true);
  expect(colors.input.every(value => value < 50)).toBe(true);
  expect(colors.iframe.every(value => value < 50)).toBe(true);
  expect(colors.shadow.every(value => value < 50)).toBe(true);
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + 90, box!.y + 70);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Clear blackouts' })).toBeEnabled();
  await page.getByRole('checkbox', { name: /I inspected the entire image/ }).check();
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByRole('status')).toContainText('TB-NATIVE-VERIFIED');
  expect(uploaded!.toString('utf8')).toContain('"screenshot_source":"browser"');
  expect(uploaded!.toString('utf8')).toContain('Native screenshot check');
  const start = uploaded!.indexOf(Buffer.from('RIFF'));
  expect(start).toBeGreaterThan(0);
  const length = uploaded!.readUInt32LE(start + 4) + 8;
  const imageBytes = uploaded!.subarray(start, start + length).toString('base64');
  const pixels = await page.evaluate(async ({ encoded, xFraction, yFraction }) => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
    const masked = [...context.getImageData(Math.round(bitmap.width * xFraction), Math.round(bitmap.height * yFraction), 1, 1).data].slice(0, 3);
    const clear = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    bitmap.close();
    return { masked, clear };
  }, { encoded: imageBytes, xFraction: 55 / box!.width, yFraction: 45 / box!.height });
  expect(pixels.masked.every(value => value < 50)).toBe(true);
  expect(pixels.clear[1]).toBeGreaterThan(130);
});

test('uploaded system screenshot works when native tab capture is unavailable', async ({ page }) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'upload-fixture', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: true } }));
  let uploaded = '';
  await page.route('**/_tracebug/reports', async route => {
    uploaded = route.request().postDataBuffer()!.toString('utf8');
    await route.fulfill({ status: 201, json: { report_id: 'TB-UPLOAD-VERIFIED' } });
  });
  await page.goto('/tests/browser/fixture.html');
  await page.getByRole('button', { name: 'Report bug' }).click();
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('Layout is broken');
  await page.getByRole('textbox', { name: 'Steps to reproduce *' }).fill('Open fixture');
  await page.locator('input[type=file]').setInputFiles({
    name: 'system-screenshot.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'),
  });
  await expect(page.getByAltText('Screenshot preview')).toBeVisible();
  await page.getByRole('checkbox', { name: /I inspected the entire image/ }).check();
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByRole('status')).toContainText('TB-UPLOAD-VERIFIED');
  expect(uploaded).toContain('"screenshot_source":"upload"');
  expect(uploaded).toContain('Layout is broken');
});

test('disabled server configuration leaves no button or event storage', async ({ page }) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: false } }));
  await page.goto('/tests/browser/fixture.html');
  await expect(page.getByRole('heading')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report bug' })).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('tracebug:')))).toEqual([]);
});

test('cancel discards QA fields and screenshot without a POST', async ({ page }) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'cancel-fixture', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: true } }));
  let posts = 0;
  await page.route('**/_tracebug/reports', route => { posts++; return route.fulfill({ status: 201, json: { report_id: 'TB-UNEXPECTED' } }); });
  await page.goto('/tests/browser/fixture.html');
  await page.getByRole('button', { name: 'Report bug' }).click();
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('Sensitive draft');
  await page.getByRole('textbox', { name: 'Steps to reproduce *' }).fill('Private steps');
  await page.locator('input[type=file]').setInputFiles({ name: 'screen.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64') });
  await expect(page.getByAltText('Screenshot preview')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Report bug' }).click();
  await expect(page.getByRole('textbox', { name: 'Problem summary *' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Steps to reproduce *' })).toHaveValue('');
  await expect(page.getByAltText('Screenshot preview')).toHaveCount(0);
  expect(posts).toBe(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('cross-origin GET remains header-free without advanced correlation opt-in', async ({ page }) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'cors-fixture', endpoint: '/_tracebug/reports', require_steps: true, correlation_headers_enabled: false } }));
  const methods: string[] = [];
  const headers: (string | null)[] = [];
  await page.route('https://api.example.test/data', route => {
    methods.push(route.request().method());
    headers.push(route.request().headers()['x-tracebug-id'] ?? null);
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4173' }, body: 'ok' });
  });
  await page.goto('/tests/browser/fixture.html');
  expect(await page.evaluate(async () => (await fetch('https://api.example.test/data')).text())).toBe('ok');
  expect(methods).toEqual(['GET']);
  expect(headers).toEqual([null]);
});

test('iframe widget offers upload fallback but no native capture', async ({ page }) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'frame-fixture', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: true } }));
  await page.goto('/tests/browser/fixture.html');
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/tests/browser/fixture.html'; document.body.append(frame); });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Report bug' }).click();
  await expect(frame.getByRole('button', { name: 'Capture this tab' })).toHaveCount(0);
  await expect(frame.getByText('Upload image')).toBeVisible();
});

test('capture permission failure still permits a metadata report', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native capture is unavailable in the mobile WebKit fixture.');
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'failure-fixture', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: true } }));
  await page.route('**/_tracebug/reports', route => route.fulfill({ status: 201, json: { report_id: 'TB-NO-IMAGE' } }));
  await page.goto('/tests/browser/fixture.html');
  await page.evaluate(() => { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) }); });
  await page.getByRole('button', { name: 'Report bug' }).click();
  await page.getByRole('button', { name: 'Capture this tab' }).click();
  await expect(page.getByRole('alert')).toContainText('Permission denied');
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('Screenshot unavailable');
  await page.getByRole('textbox', { name: 'Steps to reproduce *' }).fill('Open fixture and deny capture');
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByRole('status')).toContainText('TB-NO-IMAGE');
});

test('metadata reporting works under a strict CSP', async ({ page }) => {
  await page.route('**/tests/browser/csp-fixture.html', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'none'; connect-src 'self'; img-src 'self' blob:" } });
  });
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'csp-fixture', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: false } }));
  await page.route('**/_tracebug/reports', route => route.fulfill({ status: 201, json: { report_id: 'TB-CSP' } }));
  await page.goto('/tests/browser/csp-fixture.html');
  await page.getByRole('button', { name: 'Report bug' }).click();
  await expect(page.locator('[data-tracebug-ui]')).toHaveCSS('position', 'fixed');
  await expect(page.getByRole('dialog')).toHaveCSS('position', 'fixed');
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('CSP layout issue');
  await page.getByRole('textbox', { name: 'Steps to reproduce *' }).fill('Open the strict CSP page');
  await page.getByRole('button', { name: 'Save report' }).click();
  await expect(page.getByRole('status')).toContainText('TB-CSP');
});
