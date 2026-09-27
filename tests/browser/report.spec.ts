import { test, expect } from '@playwright/test';

test('QA summary and diagnostic evidence are submitted without a screenshot', async ({ page }, testInfo) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'browser-fixture', endpoint: '/_tracebug/reports' } }));
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
  await expect.poll(() => page.evaluate(() => {
    const events = JSON.parse(sessionStorage.getItem('tracebug:v1:browser-fixture') ?? '[]');
    return events.filter((event: any) => event.type === 'network' && event.data.status === 500).length;
  })).toBe(2);

  await page.getByRole('button', { name: 'Report bug' }).click();
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('Order save returned an error');
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
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'native-fixture', endpoint: '/_tracebug/reports' } }));
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
    };
  }, { privatePoint, inputPoint });
  expect(colors.clear[0]).toBeLessThan(50);
  expect(colors.clear[1]).toBeGreaterThan(130);
  expect(colors.private.every(value => value < 50)).toBe(true);
  expect(colors.input.every(value => value < 50)).toBe(true);
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + 90, box!.y + 70);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Clear blackouts' })).toBeEnabled();
  await page.getByRole('checkbox', { name: /I checked this shows/ }).check();
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
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: true, scope: 'upload-fixture', endpoint: '/_tracebug/reports' } }));
  let uploaded = '';
  await page.route('**/_tracebug/reports', async route => {
    uploaded = route.request().postDataBuffer()!.toString('utf8');
    await route.fulfill({ status: 201, json: { report_id: 'TB-UPLOAD-VERIFIED' } });
  });
  await page.goto('/tests/browser/fixture.html');
  await page.getByRole('button', { name: 'Report bug' }).click();
  await page.getByRole('textbox', { name: 'Problem summary *' }).fill('Layout is broken');
  await page.locator('input[type=file]').setInputFiles({
    name: 'system-screenshot.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'),
  });
  await expect(page.getByAltText('Screenshot preview')).toBeVisible();
  await page.getByRole('checkbox', { name: /I checked this shows/ }).check();
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
