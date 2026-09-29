// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { startTraceBug, TraceBugButton, TraceBugPlugin } from '../../resources/js/vue';

const screenshotMock = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../../resources/js/screenshot', async importOriginal => ({
  ...await importOriginal<typeof import('../../resources/js/screenshot')>(),
  prepareScreenshot: screenshotMock.prepare,
}));

const originalFetch = window.fetch;
afterEach(() => { window.fetch = originalFetch; document.body.replaceChildren(); screenshotMock.prepare.mockReset(); vi.restoreAllMocks(); });

it('rejects simultaneous Vue roots and releases ownership on unmount', () => {
  window.fetch = vi.fn(async () => new Response(JSON.stringify({ enabled: false })));
  const first = createApp({ render: () => h('div', 'first') });
  const second = createApp({ render: () => h('div', 'second') });
  const target = document.createElement('div'); document.body.append(target);
  first.use(TraceBugPlugin); first.mount(target);
  expect(() => second.use(TraceBugPlugin)).toThrow('one Vue root');
  first.unmount();
  const third = createApp({ render: () => h('div', 'third') });
  expect(() => third.use(TraceBugPlugin)).not.toThrow();
  third.mount(target); third.unmount();
});

it('removes the widget and active reference when access is stopped', async () => {
  window.fetch = vi.fn(async () => new Response(JSON.stringify({ enabled: true, scope: 'vue-user', endpoint: '/_tracebug/reports', require_steps: true })));
  const target = document.createElement('div'); document.body.append(target);
  const app = createApp({ render: () => h(TraceBugButton) });
  app.use(TraceBugPlugin); app.mount(target);
  const client = await startTraceBug();
  await nextTick();
  expect(target.textContent).toContain('Report bug');
  client?.stop();
  await nextTick();
  expect(target.textContent).not.toContain('Report bug');
  app.unmount();
});

it('ignores a screenshot that finishes after cancel and reopen', async () => {
  window.fetch = vi.fn(async () => new Response(JSON.stringify({ enabled: true, scope: 'late-image', endpoint: '/_tracebug/reports', require_steps: true, screenshot_enabled: true })));
  let finish!: (image: Blob) => void;
  screenshotMock.prepare.mockReturnValue(new Promise<Blob>(resolve => { finish = resolve; }));
  const createObjectURL = vi.fn(() => 'blob:late-image');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  const target = document.createElement('div'); document.body.append(target);
  const app = createApp({ render: () => h(TraceBugButton) });
  try {
    app.use(TraceBugPlugin); app.mount(target);
    await startTraceBug(); await nextTick();
    (target.querySelector('button') as HTMLButtonElement).click(); await nextTick();
    const input = target.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['pixels'], 'screen.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    (target.querySelector('button[aria-label="Close report"]') as HTMLButtonElement).click(); await nextTick();
    (target.querySelector('button') as HTMLButtonElement).click(); await nextTick();
    finish(new Blob(['pixels'], { type: 'image/webp' }));
    await Promise.resolve(); await nextTick();
    expect(target.querySelector('img[alt="Screenshot preview"]')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    delete (URL as any).createObjectURL;
    delete (URL as any).revokeObjectURL;
  }
});
