# TraceBug

Reusable, opt-in diagnostic reports for **Laravel 12 and 13, PHP 8.2+ (Laravel 13 requires PHP 8.3+), and Vue 3.3+**. Supports Vue applications with or without Inertia. The framework-neutral core also works in Blade/jQuery pages backed by Laravel.

Current GitHub tag: **v0.1.6**. Install this tag to get the QA form and native browser screenshot. The packages are not published to Packagist or the npm registry. No database migrations, dashboard, background uploads, or hosted service. Test in a staging application before enabling it for selected production users. Laravel 12 and 13 are tested in CI; later major versions will be added after testing. Older Laravel versions and Vue 2 are not declared compatible.

## Quick start: install from GitHub (Laravel + Vue 3)

The Composer and npm dependencies both come from the same `v0.1.6` Git tag. Pin both to that tag when upgrading.

1. In the consuming Laravel application's `composer.json`, add the GitHub VCS repository:

   ```json
   "repositories": [{
     "type": "vcs",
     "url": "https://github.com/CalvinChong123/TraceBug.git"
   }]
   ```

   Then run `composer require tracebug/laravel:0.1.6` and `php artisan vendor:publish --tag=tracebug-config`.

2. In the same application, run `npm install github:CalvinChong123/TraceBug#v0.1.6`. In `.env`, set `TRACEBUG_ENABLED=true` and `TRACEBUG_ALLOWED_USERS=1` (replace `1` with your QA user's ID). Run `php artisan config:clear` if configuration was cached.

3. In the root Blade template's `<head>`, add:

   ```blade
   <meta name="csrf-token" content="{{ csrf_token() }}">
   @if(app(\TraceBug\Access::class)->allows(request()))
       <meta name="tracebug-enabled" content="1">
   @endif
   ```

4. Before mounting Vue, install the plugin for eligible users:

   ```js
   if (document.querySelector('meta[name="tracebug-enabled"]')) {
     const { TraceBugPlugin } = await import('@tracebug/vue');
     app.use(TraceBugPlugin);
   }
   app.mount('#app');
   ```

   In a persistent Vue layout, show the button when the plugin is loaded:

   ```vue
   <script setup>
   import { getCurrentInstance } from 'vue';
   const TraceBugButton = getCurrentInstance().appContext.components.TraceBugButton;
   </script>

   <template>
     <slot />
     <component :is="TraceBugButton" v-if="TraceBugButton" />
   </template>
   ```

5. Log in as the allowed user, click **Report bug**, enter a summary, optionally attach a reviewed screenshot, and submit. Send the displayed `TB-...` report ID and summary to the developer. The developer runs `php artisan tracebug:show TB-...` to inspect the private report, or `php artisan tracebug:list` to browse recent summaries.

For related Laravel request and exception context, add `TraceBug\Http\RecordRequest` after session/auth middleware as shown in [the request correlation section](#4-enable-request-correlation). The basic QA report works without this enrichment. The default report storage is `storage/logs/tracebug`.

## What it captures

- Three-minute, 50-event, 48 KB browser buffer, with reserved room for errors.
- Safe navigation/click labels; Fetch and XHR metadata (including Axios using those transports); JS/Vue errors; optional console errors.
- Request IDs and short-lived, user/session-scoped Laravel response/exception context.
- Viewport overflow candidates and visible broken images, with a bounded DOM scan.
- A QA problem summary and optional reproduction steps, expected result and actual result.
- An optional browser-rendered tab screenshot or pasted/uploaded system screenshot. QA previews the image and can black out regions before submission.
- Private JSON files, a human-readable summary, and an index log.

Screenshot capture failures do not prevent metadata reports. Network bodies and headers are never recorded. Error messages and arbitrary console text are off by default. Durable reports exist only after submission; temporary server request metadata expires after five minutes.

## Install into another Laravel project

Keep this repository as the shared package source. Do not copy its implementation into each application.

### 1. Laravel dependency

Install the tagged repository as a Composer VCS dependency. In the application's `composer.json`, add:

```json
"repositories": [
  {
    "type": "vcs",
    "url": "https://github.com/CalvinChong123/TraceBug.git"
  }
]
```

Then run in the application:

```shell
composer require tracebug/laravel:0.1.6
php artisan vendor:publish --tag=tracebug-config
```

For local development while editing TraceBug, use a Composer path repository instead. This symlinks the package source, so edits in `C:/laragon/www/bug-tracking` are immediately visible to the application after Composer autoload refreshes:

```json
"repositories": [
  {
    "type": "path",
    "url": "C:/laragon/www/bug-tracking",
    "options": { "symlink": true, "versions": { "tracebug/laravel": "0.1.6" } }
  }
]
```

Then run:

```shell
composer require tracebug/laravel:0.1.6
php artisan vendor:publish --tag=tracebug-config
```

The service provider is auto-discovered.

### 2. JavaScript dependency

Recommended GitHub install:

```shell
npm install github:CalvinChong123/TraceBug#v0.1.6
```

For local development while editing TraceBug:

```shell
npm install C:/laragon/www/bug-tracking
```

The tarball flow is only for quick offline tests:

```shell
cd C:/laragon/www/bug-tracking
npm ci
npm pack
cd C:/laragon/www/your-app
npm install C:/laragon/www/bug-tracking/tracebug-vue-0.1.6.tgz
```

Import Vue components and the core through the documented exports only.

### 3. Enable selected users

```dotenv
TRACEBUG_ENABLED=true
TRACEBUG_ALLOWED_USERS=1,5,28
TRACEBUG_RELEASE=your-deployment-commit
```

An empty allowlist allows **all authenticated users**, never guests. IDs can be integers or UUIDs. `APP_DEBUG` and `APP_ENV` do not control access. Rebuild Laravel's config cache after changing environment configuration.

### 4. Enable request correlation

In Laravel 12 or 13 `bootstrap/app.php`, add to your existing middleware configuration:

```php
use Illuminate\Foundation\Configuration\Middleware;
use TraceBug\Http\RecordRequest;

->withMiddleware(function (Middleware $middleware) {
    $middleware->web(append: [RecordRequest::class]);
})
```

This middleware must run after session initialization, with the application's authenticated user resolvable. For API routes, place it after your authentication middleware, for example:

```php
Route::middleware(['auth:sanctum', \TraceBug\Http\RecordRequest::class])
    ->group(function () {
        // Existing API routes.
    });
```

Apply it once per request. It records only eligible users' requests, skips TraceBug endpoints, and leaves disabled requests untouched. Requests outside this middleware have browser evidence but no server enrichment. Server processes that crash before returning a response may have no saved context.

### 5. Load Vue integration only for eligible users

In your root Blade template's `<head>`:

```blade
<meta name="csrf-token" content="{{ csrf_token() }}">
@if(app(\TraceBug\Access::class)->allows(request()))
    <meta name="tracebug-enabled" content="1">
@endif
```

The CSRF meta tag is required for the default `web` submission route. The package uses it for transport only; it is not diagnostic evidence.

For a regular Vue entry point, install before mounting:

```js
const app = createApp(App);

if (document.querySelector('meta[name="tracebug-enabled"]')) {
  const { TraceBugPlugin } = await import('@tracebug/vue');
  app.use(TraceBugPlugin);
}

app.mount('#app');
```

In an Inertia setup callback:

```js
async setup({ el, App, props, plugin }) {
  const app = createApp({ render: () => h(App, props) }).use(plugin);
  if (document.querySelector('meta[name="tracebug-enabled"]')) {
    const { TraceBugPlugin } = await import('@tracebug/vue');
    app.use(TraceBugPlugin);
  }
  app.mount(el);
}
```

In your persistent Vue layout, resolve the optional globally registered component so disabled users do not need to import the package:

```vue
<script setup>
import { getCurrentInstance } from 'vue';
const TraceBugButton = getCurrentInstance().appContext.components.TraceBugButton;
</script>

<template>
  <slot />
  <component :is="TraceBugButton" v-if="TraceBugButton" position="bottom-right" />
</template>
```

Supported corners: `bottom-right`, `bottom-left`, `top-right`, `top-left`. Mount one button in a persistent layout. Eligibility is checked again by Laravel before submission. A newly authorized user must reload to load the integration.

The Vue Report button opens a QA form. QA enters a short problem summary, optionally adds steps/expected/actual, and chooses a screenshot. The browser capture button calls the Screen Capture API after a user click; the browser asks QA to choose a source. Choose **this tab**. The capture is browser-rendered pixels. Browsers without this API can use a pasted or uploaded system screenshot. QA must inspect the preview and confirm it is the intended page; drag over any additional sensitive area to black it out. `screenshot: false` hides screenshot controls. After submission, QA can copy the Report ID or a note containing the summary and ID to send to a developer.

On logout/account switching, stop the recorder **before** changing identity:

```js
import { useTraceBug } from '@tracebug/vue';
const tracebug = useTraceBug(); // Within a Vue setup function.
tracebug.value?.stop();
```

Prefer a full page navigation for logout. Do not keep recording across user accounts in an SPA.

## Separate Vue frontend / Laravel API

Set `tracebug.middleware` to `['api', 'auth:sanctum']` and configure the appropriate guard if necessary. Install the frontend package after your normal authentication/eligibility bootstrap:

```js
app.use(TraceBugPlugin, {
  configUrl: 'https://api.example.com/_tracebug/config',
  credentials: 'include', // Only when using cookie-based authentication.
  correlationOrigins: ['https://api.example.com'],
  headers: () => ({ /* Your app's CSRF or bearer authentication headers. */ }),
});
```

Authentication headers supplied here are used only on TraceBug requests. Your application's normal Fetch/Axios authentication remains your responsibility. For cross-origin cookie sessions, follow your existing Sanctum CSRF bootstrap; the package does not scrape cookies. Set the `X-XSRF-TOKEN` header through `headers` if your application requires it.

CORS must allow the frontend origin and `X-TraceBug-ID`, authentication, and CSRF headers as appropriate; expose `X-Request-ID`. Do not use a wildcard origin with credentials. Correlation headers are never added to unconfigured third-party origins. No Axios interceptor installation is necessary.

## Privacy integration

```html
<section data-tracebug-private>Customer identity / payment information</section>
<button data-tracebug-label="Save quotation">Save</button>
```

For native tab capture, inputs, textareas, selects, editable content, and `data-tracebug-private` regions are blacked out in the screenshot pixels before upload. Uploaded or pasted images cannot be mapped reliably to page elements, so QA must inspect and black out sensitive areas manually. Capture never edits the live page. Safe click labels use explicit `data-tracebug-label` or the tag name; arbitrary text and accessibility labels are not collected. Page titles are intentionally omitted because they commonly contain customer data.

**Mark sensitive non-form content yourself.** No screenshot method can know whether arbitrary visible business text is confidential. The server cannot redact pixels after upload. CSS backgrounds, charts, canvas content, and custom controls containing private data need a marked ancestor for automatic masking; QA should verify every screenshot preview and add blackouts. Review a sample report in staging.

Additional options:

```js
app.use(TraceBugPlugin, {
  screenshot: true,
  privateSelector: '.customer-details, .payment-summary',
  captureMessages: false,
  captureConsole: false,
  sanitizeUrl: path => path.replace(/\/customers\/[^/]+/g, '/customers/:id'),
  redact: event => event, // Return null to omit; do not add sensitive data.
});
```

URLs lose origin, query, fragment, numeric IDs and long opaque path segments by default. Project-specific sensitive path segments need `sanitizeUrl` and corresponding backend `redact_patterns`. `captureMessages` is an explicit opt-in, not a guarantee that regex masking detects every secret. Laravel exception messages have a separate `include_exception_messages` option, also false by default.

## Reports and operations

Reports are stored in `storage/logs/tracebug/reports/TB-.../` with `report.json`, `report.log`, `network.json`, `console.json`, `ui-diagnostics.json`, and an optional `screenshot.webp` (PNG/JPEG accepted when appropriate). `report.json` is authoritative and includes schema version 1. The QA summary, optional reproduction fields and screenshot source are included. `tracebug:list` shows recent summaries; `tracebug:show <Report ID>` shows the summary and report/screenshot paths; `--json` shows all recorded evidence. There are no report-download HTTP routes.

```shell
php artisan tracebug:list
php artisan tracebug:show TB-0123456789ABCDEF0123456789ABCDEF
php artisan tracebug:show TB-0123456789ABCDEF0123456789ABCDEF --json
php artisan tracebug:prune --days=30 --dry-run
php artisan tracebug:prune --days=30
```

Schedule pruning in the consuming application's `routes/console.php`:

```php
use Illuminate\Support\Facades\Schedule;
Schedule::command('tracebug:prune')->daily();
```

Configure Laravel's scheduler on the server. Temporary context expires logically after five minutes; daily pruning removes physically retained expired files. Restrict OS directory permissions (Windows needs appropriate NTFS ACLs), exclude reports from source control, and apply your backup-retention policy. Keep storage outside `public`; the package rejects public-directory paths. Rotate `tracebug.log` with your normal server log rotation.

Set web-server/PHP upload limits above the configured 2 MB screenshot plus 128 KB payload. Submission rate defaults to six/minute per user/session. Retrying reuses the submission key; committed retries return the same report ID. Retry evidence, including the screenshot, stays in memory and is lost on reload; the sanitized event buffer can survive same-tab reloads.

File storage assumes a single application server or a shared filesystem with reliable atomic file/lock semantics. Multi-node local disks are not sufficient for request correlation or idempotency. Large installations should validate storage load before wider enablement.

## Blade-only integration

After the server eligibility check, dynamically import `@tracebug/vue/core` and call `startTraceBug()`. It returns `null` when unavailable or a client with `report({ summary, steps?, expected?, actual?, screenshot?, screenshotSource? })`, `recordError()` and `stop()`. Connect your own Blade button to `report({ summary })` and display its returned Report ID. A summary of at least three characters is required. Omitting `screenshot` submits no image. A custom Blade integration may also pass a reviewed screenshot `Blob` with `screenshotSource: 'upload'` or `'paste'`; the Vue button already provides native tab capture and preview. No Vue dependency is imported by the core entry point, though the npm package declares Vue as a peer for its Vue integration.

### Example: Laravel 12 + Blade

Install dependencies from the public GitHub repository:

```json
"repositories": [
  {
    "type": "vcs",
    "url": "https://github.com/CalvinChong123/TraceBug.git"
  }
]
```

Then run:

```shell
composer require tracebug/laravel:0.1.6
php artisan vendor:publish --tag=tracebug-config
npm install github:CalvinChong123/TraceBug#v0.1.6
```

Enable only your test admin/user ID in `.env`:

```dotenv
TRACEBUG_ENABLED=true
TRACEBUG_ALLOWED_USERS=1
TRACEBUG_RELEASE=your-deployment-commit
```

Append `\TraceBug\Http\RecordRequest::class` to the `web` middleware group in `bootstrap/app.php` as described above.

In `resources/views/layouts/app.blade.php`, keep the existing CSRF meta and add this in `<head>`:

```blade
@if(app(\TraceBug\Access::class)->allows(request()))
    <meta name="tracebug-enabled" content="1">
@endif
```

Add a button for logged-in pages before `</body>`:

```blade
@if(app(\TraceBug\Access::class)->allows(request()))
    <button
        id="tracebug-report-button"
        type="button"
        style="position:fixed;right:16px;bottom:16px;z-index:2147483647"
    >
        Report bug
    </button>
@endif
```

In `resources/js/app.js`, add:

```js
if (document.querySelector('meta[name="tracebug-enabled"]')) {
  import('@tracebug/vue/core').then(({ startTraceBug }) => {
    startTraceBug().then((client) => {
      if (!client) {
        return;
      }

      const button = document.getElementById('tracebug-report-button');
      if (!button) {
        return;
      }

      button.addEventListener('click', async () => {
        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = 'Reporting...';
        try {
          const summary = window.prompt('What went wrong?')?.trim();
          if (!summary) return;
          const reportId = await client.report({ summary });
          button.textContent = reportId;
        } catch (error) {
          button.textContent = 'Try again';
        } finally {
          setTimeout(() => {
            button.disabled = false;
            button.textContent = originalText;
          }, 3000);
        }
      });
    });
  });
}
```

Rebuild assets and clear config cache:

```shell
npm run dev
php artisan config:clear
```

Log in as the allowed user, click **Report bug**, then inspect reports:

```shell
php artisan tracebug:list
php artisan tracebug:show TB-0123456789ABCDEF0123456789ABCDEF
```

## Development and verification

```shell
composer install
composer test
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium webkit
npx playwright test
npm pack
```

PHP feature tests cover authorization, redaction, private report persistence, idempotency, scope isolation, exception context, validation, image uploads, rate limits and pruning. JavaScript tests cover retention, privacy, request behavior, retries and account changes. Browser tests exercise Vue, native video-frame capture with a test stream, pixel masking, Fetch/XHR and UI evidence in Chromium and mobile-emulated WebKit. WebKit emulation is not a substitute for testing on a physical iPhone/Safari deployment.

Known limitations: Native tab capture requires a secure context, browser support, a user gesture and a fresh browser permission prompt. The browser picker may offer other tabs, so QA must choose this tab and verify the preview. Mobile browsers may not expose tab capture; paste/upload remains available. Only events after initialization are observed. CSS background-image failures and all browser network causes cannot be reliably identified. A hung JS thread cannot service a Report click. Minified Vue errors do not resolve to original source without an external source-map workflow. AJAX timings measure response-header availability for Fetch, not complete response-body download. No offline queue, issue tracker, dashboard or automatic reporting is included.
