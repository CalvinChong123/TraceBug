import { defineComponent, h, inject, onBeforeUnmount, onMounted, ref, shallowRef, type App, type InjectionKey, type ShallowRef } from 'vue';
import { startTraceBug } from './core';
import type { TraceBugClient, TraceBugOptions } from './types';
export { startTraceBug } from './core';
export type { TraceBugClient, TraceBugOptions, TraceBugEvent } from './types';

const key: InjectionKey<ShallowRef<TraceBugClient | null>> = Symbol('TraceBug');

export const TraceBugPlugin = {
  install(app: App, options: TraceBugOptions = {}) {
    const client = shallowRef<TraceBugClient | null>(null);
    app.provide(key, client);
    app.component('TraceBugButton', TraceBugButton);
    const previous = app.config.errorHandler;
    const handler: NonNullable<typeof previous> = (error, instance, info) => {
      client.value?.recordError(error, info);
      if (previous) previous(error, instance, info);
      else console.error(error);
    };
    let disposed = false;
    void startTraceBug(options).then(value => {
      if (disposed) value?.stop();
      else {
        client.value = value;
        if (value) app.config.errorHandler = handler;
      }
    });
    const unmount = app.unmount.bind(app);
    app.unmount = () => {
      disposed = true;
      client.value?.stop();
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
    const loading = ref(false);
    const failed = ref(false);
    const message = ref('');
    let mounted = false;
    onMounted(() => { mounted = true; });
    onBeforeUnmount(() => { mounted = false; });
    const report = async () => {
      if (!client.value || loading.value) return;
      loading.value = true;
      message.value = '';
      try { const id = await client.value.report(); if (mounted) { message.value = `Report saved: ${id}`; failed.value = false; } }
      catch (error) { if (mounted) { message.value = error instanceof Error ? error.message : 'Report failed. Please retry.'; failed.value = true; } }
      finally { if (mounted) loading.value = false; }
    };
    return () => client.value ? h('div', {
      'data-tracebug-ui': '',
      style: { position: 'fixed', zIndex: 2147483000, [props.position.startsWith('top') ? 'top' : 'bottom']: '16px', [props.position.endsWith('left') ? 'left' : 'right']: '16px', maxWidth: 'min(360px, calc(100vw - 32px))', fontFamily: 'system-ui, sans-serif', fontSize: '13px' },
    }, [
      h('button', { type: 'button', disabled: loading.value, onClick: report, 'aria-busy': loading.value,
        style: { background: '#172554', color: '#fff', border: '1px solid #64748b', borderRadius: '8px', padding: '10px 16px', cursor: loading.value ? 'wait' : 'pointer', font: 'inherit' } }, loading.value ? 'Saving report…' : failed.value ? 'Retry report' : 'Report bug'),
      message.value ? h('p', { role: 'status', 'aria-live': 'polite', style: { background: '#fff', color: '#172554', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', overflowWrap: 'anywhere' } }, message.value) : null,
    ]) : null;
  },
});

export default TraceBugPlugin;
