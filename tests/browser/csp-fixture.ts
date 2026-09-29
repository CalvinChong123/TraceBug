import { createApp, h } from 'vue';
import { TraceBugPlugin, TraceBugButton } from '/dist/vue.js';

const app = createApp({ render: () => h('main', [h('h1', 'Strict CSP host'), h(TraceBugButton)]) });
app.use(TraceBugPlugin);
app.mount('#app');
