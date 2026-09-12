import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: { core: 'resources/js/core.ts', vue: 'resources/js/vue.ts' }, formats: ['es'] },
    rollupOptions: { external: ['vue'] },
  },
});
