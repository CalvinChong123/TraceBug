import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('Vue reports capture real redacted canvas, failed fetch/XHR, and UI evidence', async ({ page }, testInfo) => {
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

  // Verify actual pixel output before report submission, using the production capture function.
  const evidence = await page.evaluate(async () => {
    // @ts-ignore Vite serves this browser module directly.
    const { capture } = await import('/resources/js/screenshot.ts');
    const blob = await capture();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let magenta = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i + 1] < 60 && pixels[i + 2] > 200) magenta++;
    bitmap.close();
    return { size: blob.size, width: canvas.width, magenta, image: canvas.toDataURL('image/png') };
  });
  expect(evidence.size).toBeGreaterThan(100);
  expect(evidence.magenta).toBe(0);
  await writeFile(testInfo.outputPath('redacted-capture.png'), Buffer.from(evidence.image.split(',')[1], 'base64'));
  await page.getByRole('button', { name: 'Report bug' }).click();
  await expect(page.getByRole('status')).toContainText('TB-BROWSER-VERIFIED', { timeout: 15000 });
  const body = uploaded!.toString('utf8');
  expect(body).toContain('"screenshot_status":"captured"');
  expect(body).toContain('"horizontal_overflow":true');
  expect(body).toContain('"status":500');
  expect(body).not.toContain('password=secret');
  expect(body).not.toContain('token=secret');
  expect(body).not.toContain('sensitive-password');
  expect(body).toContain('name="screenshot"');
});

test('disabled server configuration leaves no button or event storage', async ({ page }) => {
  await page.route('**/_tracebug/config', route => route.fulfill({ json: { enabled: false } }));
  await page.goto('/tests/browser/fixture.html');
  await expect(page.getByRole('heading')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report bug' })).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('tracebug:')))).toEqual([]);
});
