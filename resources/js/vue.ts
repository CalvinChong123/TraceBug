import { defineComponent, h, inject, nextTick, onBeforeUnmount, ref, shallowRef, type App, type InjectionKey, type ShallowRef } from 'vue';
import { startTraceBug } from './core';
import { PRIVATE_SELECTOR, safeText } from './privacy';
import { captureBrowserTab, prepareScreenshot, redactScreenshot, type RedactionRect } from './screenshot';
import type { ScreenshotSource, TraceBugClient, TraceBugOptions } from './types';
export { startTraceBug } from './core';
export type { TraceBugClient, TraceBugOptions, TraceBugEvent, TraceBugReportInput, ScreenshotSource } from './types';

const key: InjectionKey<ShallowRef<TraceBugClient | null>> = Symbol('TraceBug');
const optionsKey: InjectionKey<TraceBugOptions> = Symbol('TraceBugOptions');
let installedApp: App | undefined;

export const TraceBugPlugin = {
  install(app: App, options: TraceBugOptions = {}) {
    if (installedApp) throw new Error('TraceBug supports one Vue root. Install the plugin once in the persistent root.');
    installedApp = app;
    const client = shallowRef<TraceBugClient | null>(null);
    app.provide(key, client);
    app.provide(optionsKey, options);
    app.component('TraceBugButton', TraceBugButton);
    const previous = app.config.errorHandler;
    const handler: NonNullable<typeof previous> = (error, instance, info) => {
      client.value?.recordError(error, info);
      if (previous) previous(error, instance, info);
      else console.error(error);
    };
    let disposed = false;
    void startTraceBug(options).then(value => {
      if (disposed) { if (!installedApp || installedApp === app) value?.stop(); }
      else {
        client.value = value;
        if (value) {
          app.config.errorHandler = handler;
          value.onStop(() => {
            if (client.value === value) client.value = null;
            if (app.config.errorHandler === handler) app.config.errorHandler = previous;
          });
        }
      }
    });
    const unmount = app.unmount.bind(app);
    app.unmount = () => {
      disposed = true;
      client.value?.stop();
      client.value = null;
      if (installedApp === app) installedApp = undefined;
      if (app.config.errorHandler === handler) app.config.errorHandler = previous;
      unmount();
    };
  },
};

export function useTraceBug() { return inject(key, shallowRef<TraceBugClient | null>(null)); }

export const TraceBugButton = defineComponent({
  name: 'TraceBugButton',
  props: {
    position: { type: String, default: 'bottom-right', validator: (value: string) => ['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(value) },
  },
  setup(props) {
    const client = useTraceBug();
    const options = inject(optionsKey, {});
    const privateSelector = `${PRIVATE_SELECTOR}${options.privateSelector ? ',' + options.privateSelector : ''}`;
    const nativeCaptureAvailable = window.top === window.self && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
    const screenshotsEnabled = () => options.screenshot !== false && client.value?.policy.screenshotsEnabled === true;
    const requireSteps = () => client.value?.policy.requireSteps !== false;
    const open = ref(false);
    const loading = ref(false);
    const locked = ref(false);
    const hiddenForCapture = ref(false);
    const error = ref('');
    const unknownResult = ref(false);
    const reportId = ref('');
    const copyMessage = ref('');
    const summary = ref('');
    const steps = ref('');
    const expected = ref('');
    const actual = ref('');
    const screenshot = shallowRef<Blob | null>(null);
    const screenshotUrl = ref('');
    const screenshotSource = ref<ScreenshotSource | null>(null);
    const screenshotReviewed = ref(false);
    const masks = ref<RedactionRect[]>([]);
    const draftMask = ref<RedactionRect | null>(null);
    let draftGeneration = 0;
    let dragStart: { x: number; y: number } | null = null;
    let summaryField: HTMLTextAreaElement | null = null;
    const field = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid #94a3b8', borderRadius: '6px', font: 'inherit' } as const;
    const button = { padding: '8px 12px', border: '1px solid #94a3b8', borderRadius: '6px', background: '#fff', color: '#172554', cursor: 'pointer', font: 'inherit' } as const;

    const setScreenshot = (blob: Blob | null, source: ScreenshotSource | null = null) => {
      if (screenshotUrl.value) URL.revokeObjectURL(screenshotUrl.value);
      screenshot.value = blob;
      screenshotUrl.value = blob ? URL.createObjectURL(blob) : '';
      screenshotSource.value = source;
      screenshotReviewed.value = false;
      masks.value = [];
      draftMask.value = null;
    };
    onBeforeUnmount(() => { draftGeneration++; hiddenForCapture.value = false; if (screenshotUrl.value) URL.revokeObjectURL(screenshotUrl.value); screenshot.value = null; client.value?.discard(); summary.value = steps.value = expected.value = actual.value = ''; });

    const reset = () => {
      draftGeneration++;
      hiddenForCapture.value = false;
      summary.value = steps.value = expected.value = actual.value = '';
      error.value = reportId.value = copyMessage.value = '';
      unknownResult.value = false;
      locked.value = false;
      setScreenshot(null);
    };
    const show = () => {
      if (reportId.value) reset();
      open.value = true;
      void nextTick(() => summaryField?.focus());
    };
    const close = () => { if (!loading.value) { client.value?.discard(); reset(); open.value = false; } };

    const chooseFile = async (file: File | null, source: ScreenshotSource) => {
      if (!file || locked.value) return;
      const generation = draftGeneration;
      try { const image = await prepareScreenshot(file); if (generation === draftGeneration && open.value && !locked.value) { setScreenshot(image, source); error.value = ''; } }
      catch (cause) { if (generation === draftGeneration && open.value) error.value = cause instanceof Error ? cause.message : 'Cannot read screenshot.'; }
    };
    const paste = (event: ClipboardEvent) => {
      if (!open.value || locked.value) return;
      const item = Array.from(event.clipboardData?.items ?? []).find(item => item.type.startsWith('image/'));
      if (item) { event.preventDefault(); void chooseFile(item.getAsFile(), 'paste'); }
    };
    const captureTab = async () => {
      if (locked.value) return;
      const generation = draftGeneration;
      error.value = '';
      try {
        const image = await captureBrowserTab(privateSelector, hidden => { if (generation === draftGeneration) hiddenForCapture.value = hidden; });
        if (generation === draftGeneration && open.value && !locked.value) setScreenshot(image, 'browser');
      }
      catch (cause) { if (generation === draftGeneration && open.value) error.value = cause instanceof Error ? cause.message : 'Browser capture failed.'; }
    };
    const point = (event: PointerEvent): { x: number; y: number } => {
      const rect = (event.currentTarget as Element).getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
    };
    const move = (event: PointerEvent) => {
      if (!dragStart) return;
      const end = point(event);
      draftMask.value = { x: Math.min(dragStart.x, end.x), y: Math.min(dragStart.y, end.y), width: Math.abs(end.x - dragStart.x), height: Math.abs(end.y - dragStart.y) };
    };
    const finish = (event: PointerEvent) => {
      if (!dragStart) return;
      move(event);
      if (draftMask.value && draftMask.value.width > 0.005 && draftMask.value.height > 0.005) {
        masks.value = [...masks.value, draftMask.value];
        screenshotReviewed.value = false;
      }
      draftMask.value = null;
      dragStart = null;
    };
    const submit = async (event: Event) => {
      event.preventDefault();
      if (!client.value || loading.value || summary.value.trim().length < 3 || (requireSteps() && !steps.value.trim()) || (screenshot.value && !screenshotReviewed.value)) return;
      loading.value = true;
      error.value = '';
      try {
        const image = screenshot.value ? await redactScreenshot(screenshot.value, masks.value) : null;
        locked.value = true; // A retry must send the same submission ID and frozen evidence.
        reportId.value = await client.value.report({ summary: summary.value, steps: steps.value, expected: expected.value, actual: actual.value,
          screenshot: image, screenshotSource: screenshotSource.value ?? undefined });
        summary.value = steps.value = expected.value = actual.value = '';
        setScreenshot(null);
      } catch (cause) { unknownResult.value = cause instanceof Error && cause.name === 'TraceBugOutcomeUnknownError'; error.value = cause instanceof Error ? cause.message : 'Report failed. Try again.'; if (client.value && !client.value.isActive()) client.value = null; }
      finally { loading.value = false; }
    };
    const copy = async (value: string, label: string) => {
      try { await navigator.clipboard.writeText(value); copyMessage.value = label; }
      catch { copyMessage.value = 'Select and copy the ID above'; }
    };
    const maskView = (rect: RedactionRect) => h('div', { style: {
      position: 'absolute', left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, background: '#0f172a', pointerEvents: 'none',
    } });
    const textarea = (label: string, value: typeof summary, max: number, required = false) => h('label', { style: { display: 'block', marginBottom: '12px', fontWeight: '600' } }, [
      label,
      h('textarea', { ref: required && label.startsWith('Problem') ? (el: unknown) => { summaryField = el instanceof HTMLTextAreaElement ? el : null; } : undefined,
        value: value.value, maxlength: max, minlength: required ? 3 : undefined, required, rows: required ? 2 : 3, disabled: locked.value, style: field,
        onInput: (event: Event) => { value.value = (event.target as HTMLTextAreaElement).value; } }),
    ]);
    return () => client.value ? h('div', {
      'data-tracebug-ui': '',
      style: { position: 'fixed', zIndex: 2147483000, [props.position.startsWith('top') ? 'top' : 'bottom']: '16px', [props.position.endsWith('left') ? 'left' : 'right']: '16px', fontFamily: 'system-ui, sans-serif', fontSize: '13px', display: hiddenForCapture.value ? 'none' : undefined },
      onPaste: paste,
    }, [
      h('button', { type: 'button', onClick: show, style: { ...button, background: '#172554', color: '#fff', padding: '10px 16px' } }, 'Report bug'),
      open.value ? h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Report a bug',
        style: { position: 'fixed', inset: '0', zIndex: 2147483001, background: 'rgba(15,23,42,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', boxSizing: 'border-box' },
        onKeydown: (event: KeyboardEvent) => { if (event.key === 'Escape') close(); },
      }, [h('form', { onSubmit: submit, style: { width: 'min(540px,100%)', maxHeight: 'min(90vh,850px)', overflowY: 'auto', padding: '20px', boxSizing: 'border-box', borderRadius: '12px', background: '#fff', color: '#172554', boxShadow: '0 20px 60px rgba(0,0,0,.25)' } }, [
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' } }, [
          h('h2', { style: { margin: '0 0 16px', fontSize: '18px' } }, reportId.value ? 'Report saved' : 'Report a bug'),
          h('button', { type: 'button', onClick: close, disabled: loading.value, 'aria-label': 'Close report', style: button }, 'Close'),
        ]),
        reportId.value ? h('div', { role: 'status', 'aria-live': 'polite' }, [
          h('p', 'Send this ID and a short summary to your developer:'),
          h('code', { style: { display: 'block', overflowWrap: 'anywhere', padding: '10px', background: '#f1f5f9', userSelect: 'all' } }, reportId.value),
          h('button', { type: 'button', onClick: () => { void copy(reportId.value, 'Report ID copied'); }, style: { ...button, marginTop: '10px' } }, 'Copy report ID'),
          copyMessage.value ? h('span', { style: { marginLeft: '10px' } }, copyMessage.value) : null,
        ]) : [
          textarea('Problem summary *', summary, 500, true),
          requireSteps() ? textarea('Steps to reproduce *', steps, 1000, true) : null,
          h('details', { style: { marginBottom: '14px' } }, [
            h('summary', { style: { cursor: 'pointer', fontWeight: '600', marginBottom: '10px' } }, 'Add more detail (optional)'),
            !requireSteps() ? textarea('Steps to reproduce', steps, 1000) : null,
            textarea('Expected result', expected, 1000),
            textarea('Actual result', actual, 1000),
          ]),
          screenshotsEnabled() ? h('div', { style: { marginBottom: '10px', fontWeight: '600' } }, 'Screenshot (optional)') : null,
          screenshotsEnabled() ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' } }, [
            nativeCaptureAvailable ? h('button', { type: 'button', disabled: locked.value, onClick: captureTab, style: button }, 'Capture this tab') : null,
            h('label', { style: { ...button, display: 'inline-block' } }, ['Upload image', h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', disabled: locked.value,
              style: { display: 'none' }, onChange: (event: Event) => { const input = event.target as HTMLInputElement; void chooseFile(input.files?.[0] ?? null, 'upload'); input.value = ''; } })]),
          ]) : null,
          screenshotsEnabled() ? h('p', { style: { margin: '0 0 10px', fontSize: '12px', color: '#475569' } }, 'Choose this tab. Masking cannot guarantee all private pixels are hidden; inspect the entire preview before submitting.') : null,
          h('p', { style: { fontSize: '12px', color: '#475569' } }, 'Evidence is limited: private form state, request bodies and full URLs are never included. Do not type passwords, tokens, payment details or customer data in this form.'),
          screenshot.value ? h('div', [
            h('div', { style: { position: 'relative', width: '100%', maxHeight: '300px', overflow: 'auto', border: '1px solid #94a3b8' } }, [
              h('div', { style: { position: 'relative', width: '100%' } }, [
                h('img', { src: screenshotUrl.value, alt: 'Screenshot preview', style: { display: 'block', width: '100%' } }),
                h('div', { role: 'img', 'aria-label': 'Drag to hide sensitive areas', style: { position: 'absolute', inset: '0', cursor: locked.value ? 'default' : 'crosshair', touchAction: 'none' },
                  onPointerdown: (event: PointerEvent) => { if (locked.value) return; dragStart = point(event); (event.currentTarget as Element).setPointerCapture(event.pointerId); },
                  onPointermove: move, onPointerup: finish, onPointercancel: () => { dragStart = null; draftMask.value = null; },
                }, [...masks.value.map(maskView), ...(draftMask.value ? [maskView(draftMask.value)] : [])]),
              ]),
            ]),
            h('p', { style: { fontSize: '12px', color: '#475569' } }, `Source: ${screenshotSource.value}. Drag on the preview to black out sensitive areas before upload.`),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' } }, [
              h('button', { type: 'button', disabled: locked.value || masks.value.length === 0, onClick: () => { masks.value = []; screenshotReviewed.value = false; }, style: button }, 'Clear blackouts'),
              h('button', { type: 'button', disabled: locked.value, onClick: () => setScreenshot(null), style: button }, 'Remove screenshot'),
            ]),
            h('label', [h('input', { type: 'checkbox', checked: screenshotReviewed.value, disabled: locked.value,
              onChange: (event: Event) => { screenshotReviewed.value = (event.target as HTMLInputElement).checked; } }), ' I inspected the entire image and confirm it contains no private content.']),
          ]) : null,
          error.value ? h('p', { role: 'alert', style: { color: '#b91c1c' } }, error.value) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } }, [
            h('button', { type: 'button', disabled: loading.value, onClick: close, style: button }, unknownResult.value ? 'Discard draft (report may exist)' : 'Cancel'),
            h('button', { type: 'submit', disabled: loading.value || summary.value.trim().length < 3 || (requireSteps() && !steps.value.trim()) || !!(screenshot.value && !screenshotReviewed.value),
              style: { ...button, background: '#172554', color: '#fff' } }, loading.value ? 'Saving…' : locked.value ? 'Retry report' : 'Save report'),
          ]),
        ],
      ])]) : null,
    ]) : null;
  },
});

export default TraceBugPlugin;
