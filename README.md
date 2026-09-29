# TraceBug

Reusable, opt-in diagnostic reports for **Laravel 9 through 13**. Laravel 9 requires PHP 8.0.2+, Laravel 10 requires PHP 8.1+, Laravel 11 and 12 require PHP 8.2+, and Laravel 13 requires PHP 8.3+. The Vue integration requires Vue 3.3+. It supports Vue applications with or without Inertia; the browser core also works in Blade/jQuery pages backed by Laravel.

This source targets **v0.2.0**. It is not yet tagged; create and verify a matching Git tag before using the VCS install commands below. The packages are not published to Packagist or the npm registry. No database migrations, dashboard, background uploads, or hosted service are required. Laravel 9 through 13 and Vue 3.3+ are declared compatible. Laravel 9 through 11 are beyond upstream security support; package compatibility does not restore framework security support.

## Quick start: install from GitHub (Laravel + Vue 3)

After the release is tagged, pin Composer and npm to the same `v0.2.0` Git tag. Until then, use a reviewed commit or a local path repository for evaluation.

1. In the consuming Laravel application's `composer.json`, add the GitHub VCS repository:

   ```json
   "repositories": [{
     "type": "vcs",
     "url": "https://github.com/CalvinChong123/TraceBug.git"
   }]
   ```

   Then run `composer require tracebug/laravel:0.2.0` and `php artisan vendor:publish --tag=tracebug-config`.

   If a Laravel 9–11 application's Composer security policy blocks its existing framework version, see [legacy Composer advisories](#legacy-composer-advisories) below.

2. In the same application, run `npm install github:CalvinChong123/TraceBug#v0.2.0`. In `.env`, set `TRACEBUG_ENABLED=true` and `TRACEBUG_ALLOWED_USERS=1` (replace `1` with your QA user's ID). Run `php artisan config:clear` if configuration was cached.

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

5. Log in as the allowed user, click **Report bug**, enter a summary and reproduction steps, and submit. Screenshots require an explicit server setting. Send the displayed `TB-...` report ID to a developer, who can inspect it with `php artisan tracebug:show` or `tracebug:list`.

The basic QA report works without server request correlation. The default report storage is `storage/logs/tracebug`.

## What it captures

- Three-minute, 50-event, 48 KB **memory-only** browser buffer, with reserved room for errors and failed/slow requests.
- URL path depth and element tag labels; Fetch and XHR metadata (including Axios using those transports); JS/Vue errors; minimal console-error metadata without arguments.
- Optional short-lived Laravel response/exception context, disabled by default because it writes before submission.
- Viewport overflow candidates and visible broken images, with a bounded DOM scan.
- A QA problem summary and required reproduction steps by default; expected/actual fields are optional.
- An optional, server-authorized screenshot that QA previews and confirms before upload. The server re-encodes accepted pixels without metadata.
- Private JSON files and a human-readable summary; there is no persistent global index.

Screenshot capture failures do not prevent metadata reports. Network bodies, headers, storage contents, arbitrary DOM text, error messages, and console arguments are not diagnostic evidence. Passive browser data is never written to browser storage. A screenshot may be captured into memory for review before Save, but is uploaded only on Save. Cancelling clears the draft. If a POST times out, its server outcome is unknown; retry with the frozen submission key or discard knowing it may have been saved.

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
composer require tracebug/laravel:0.2.0
php artisan vendor:publish --tag=tracebug-config
```

For local development while editing TraceBug, use a Composer path repository instead. This symlinks the package source, so edits in `C:/laragon/www/bug-tracking` are immediately visible to the application after Composer autoload refreshes:

```json
"repositories": [
  {
    "type": "path",
    "url": "C:/laragon/www/bug-tracking",
    "options": { "symlink": true, "versions": { "tracebug/laravel": "0.2.0" } }
  }
]
```

Then run:

```shell
composer require tracebug/laravel:0.2.0
php artisan vendor:publish --tag=tracebug-config
```

The service provider is auto-discovered.

#### Legacy Composer advisories

Laravel 9–11 are past upstream security support. Recent Composer versions may refuse to resolve an existing `laravel/framework` 9, 10 or 11 dependency because of known advisories, even when TraceBug itself supports that framework API. TraceBug does not change the consuming application's security policy.

If your team has accepted that existing legacy-framework risk, scope a Composer exception to the application's actual Laravel major version. For example, in a Laravel 9 application's `composer.json`, merge this into its existing `config` object before running `composer require`:

```json
"policy": {
  "advisories": {
    "ignore": {
      "laravel/framework": {
        "constraint": "^9.0",
        "on-audit": false,
        "reason": "Existing Laravel 9 application; retain audit visibility while planning an upgrade."
      }
    }
  }
}
```

Use `^10.0` or `^11.0` only in an application on that version. This exception permits dependency resolution while Composer continues reporting those advisories during audits. Review any other blocked package separately; the package does not apply a global advisory override. See [Composer's policy documentation](https://getcomposer.org/doc/06-config.md#ignore-format).

### 2. JavaScript dependency

Recommended GitHub install:

```shell
npm install github:CalvinChong123/TraceBug#v0.2.0
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
npm install C:/laragon/www/bug-tracking/tracebug-vue-0.2.0.tgz
```

Import Vue components and the core through the documented exports only.

### 3. Enable selected users

```dotenv
TRACEBUG_ENABLED=true
TRACEBUG_ALLOWED_USERS=1,5,28
TRACEBUG_RELEASE=your-deployment-commit
```

An empty allowlist **denies everyone** unless `tracebug.gate` names an explicitly defined Laravel Gate ability. A missing `APP_KEY` or a failing Gate also denies access. IDs can be integers or UUIDs. `APP_DEBUG` and `APP_ENV` do not control access. Rebuild Laravel's config cache after changing environment configuration.

### 4. Enable request correlation

This is an **advanced privacy opt-in**. The default `record_server_context=false` makes no pre-submit server diagnostic files and adds no request ID header. Enabling it writes bounded request metadata to the private file cache for eligible users before they submit. This is an explicit exception to the memory-only pre-submit model. Do not enable it where that exception is unacceptable. Set `record_server_context=true` in published `config/tracebug.php` only after a privacy review.

In Laravel 11, 12 or 13 `bootstrap/app.php`, add to your existing middleware configuration:

```php
use Illuminate\Foundation\Configuration\Middleware;
use TraceBug\Http\RecordRequest;

->withMiddleware(function (Middleware $middleware) {
    $middleware->web(append: [RecordRequest::class]);
})
```

In Laravel 9 or 10, **append one line inside your existing** `web` middleware group in `app/Http/Kernel.php`, after session and authentication middleware. Do not replace the group:

```php
// Inside your existing 'web' => [ ... ] array, after the existing entries:
\TraceBug\Http\RecordRequest::class,
```

This middleware must run after session initialization, with the application's authenticated user resolvable. For API routes, place it after your authentication middleware, for example:

```php
Route::middleware(['auth:sanctum', \TraceBug\Http\RecordRequest::class])
    ->group(function () {
        // Existing API routes.
    });
```

Apply it once per request. It records only eligible users' requests when `record_server_context=true`, skips TraceBug endpoints, and leaves disabled requests untouched. Server processes that crash before returning a response may have no saved context. Correlation headers are separate: they are not added to Fetch/XHR by default. Advanced header injection requires both `correlation_headers_enabled=true` on the server and `correlateRequests: true` in the client, plus a CORS/header-signing review.

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

The Vue Report button requires a short summary and reproduction steps by default. Screenshots are hidden unless the server sets `screenshots_enabled=true`; client `screenshot: false` can further disable them. Native capture is unavailable inside iframes. The browser picker can offer other tabs, and automatic masking cannot guarantee privacy. QA must choose this tab, inspect the entire preview, black out additional private pixels, and explicitly confirm before Save. Paste/upload remains a fallback. After success, QA fields and screenshot data are cleared from the widget; QA can copy the Report ID.

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
  // No request headers are added to application Fetch/XHR calls by default.
  headers: () => ({ /* Your app's CSRF or bearer authentication headers. */ }),
});
```

Authentication headers supplied here are used only on TraceBug requests. Your application's normal Fetch/Axios authentication remains your responsibility. For cross-origin cookie sessions, follow your existing Sanctum CSRF bootstrap; the package does not scrape cookies. Set the `X-XSRF-TOKEN` header through `headers` if your application requires it.

CORS must allow the frontend origin and the authentication/CSRF headers used by TraceBug's own config and report requests. Do not use a wildcard origin with credentials. Only an advanced header-injection deployment also needs to allow `X-TraceBug-ID` and expose `X-Request-ID`; the default does not change application requests or introduce a preflight.

## Privacy integration

```html
<section data-tracebug-private>Customer identity / payment information</section>
<button>Save</button>
```

For native tab capture, inputs, textareas, selects, editable content, marked private regions, iframes, embedded objects, and shadow/custom-element hosts are blacked out where the current tab's coordinates match the image. This is a conservative aid, **not a privacy guarantee**. The browser picker can select another tab, and pasted/uploaded images cannot be mapped reliably to DOM elements. QA must inspect the entire preview and manually black out sensitive pixels. Capture never edits the live page. Click labels are tag names only; arbitrary text, IDs, accessibility labels, and page titles are not collected.

**Mark sensitive non-form content yourself.** CSS backgrounds, charts, canvas, and custom controls can contain private pixels. The server strips image metadata but cannot understand or redact visible private content. For sensitive production pages, leave screenshots disabled. Review sample reports and screenshot behavior in staging before an explicit opt-in.

Additional options:

The screenshot option below only has an effect after the server's `screenshots_enabled` setting is explicitly enabled for this deployment.

```js
app.use(TraceBugPlugin, {
  screenshot: true,
  privateSelector: '.customer-details, .payment-summary',
  captureConsole: true, // Only the fixed ConsoleError name; no arguments.
  redact: event => event, // Return null to omit; server rejects unknown fields.
});
```

All URL path segment **values** are replaced with `:segment`; origin, query, and fragment are removed. This sacrifices exact route names to avoid storing short tokens, names, and identifiers. `captureMessages` is retained for source compatibility but ignored: error messages and console arguments are never stored. `sanitizeUrl` can only further sanitize; the server applies path-shape conversion again. Free-text QA fields remain a human privacy responsibility and receive defense-in-depth redaction, which cannot guarantee removal of every possible secret.

## Reports and operations

Reports are stored in `storage/logs/tracebug/reports/TB-.../` with `report.json`, `report.log`, `network.json`, `console.json`, `ui-diagnostics.json`, `complete.json`, and an optional metadata-free `screenshot.webp`. A keyed `user_ref` replaces the raw authentication identifier, which may itself be an email. `complete.json` carries the payload digest; only a matching completed report is an idempotent retry. A changed payload or partial directory returns 409. `tracebug:list` scans retained reports; `tracebug:show <Report ID>` reads their files. There are no report-download HTTP routes.

```shell
php artisan tracebug:list
php artisan tracebug:show TB-0123456789ABCDEF0123456789ABCDEF
php artisan tracebug:show TB-0123456789ABCDEF0123456789ABCDEF --json
php artisan tracebug:prune --days=30 --dry-run
php artisan tracebug:prune --days=30
```

In Laravel 11 through 13, schedule pruning in the consuming application's `routes/console.php`:

```php
use Illuminate\Support\Facades\Schedule;
Schedule::command('tracebug:prune')->daily();
```

In Laravel 9 or 10, add `$schedule->command('tracebug:prune')->daily();` to the `schedule(Schedule $schedule)` method in `app/Console/Kernel.php`.

**Production gate:** configure Laravel's scheduler and verify that `tracebug:prune --days=30 --dry-run` works before enabling the package. The command removes aged reports, abandoned pending folders, old context files, and any legacy `tracebug.log` index. No new global index is written. The package cannot verify that the host scheduler actually runs, so monitor the command and disk usage. Use a dedicated private storage directory outside `public`; a pre-existing POSIX directory must already have mode `0700` because TraceBug will not change a shared directory's permissions. Exclude it from source control and public backups, and apply the same retention to backups. On Windows, set and audit NTFS ACLs explicitly for the application service account; PHP `chmod` is not an ACL guarantee. Avoid symlinked report paths.

Set web-server/PHP upload limits above the configured 2 MB screenshot plus 128 KB payload. Enable the GD extension for server-side screenshot re-encoding; without it, the screenshot controls are hidden and a direct screenshot submission fails validation while metadata reports remain available. Submission rate defaults to six/minute per user/session. Retrying a failed or unknown-outcome submission reuses its frozen key; discarding clears it. All passive event evidence is memory-only and is lost on reload, cancellation, or successful submission.

File storage assumes a single application server or a shared filesystem with reliable atomic rename and file-lock semantics. Multi-node local disks are not sufficient for idempotency or optional request context. Validate storage capacity before wider enablement.

## Blade-only integration

After the server eligibility check, dynamically import `@tracebug/vue/core` and call `startTraceBug()`. It returns `null` when unavailable or a client with `report({ summary, steps, expected?, actual?, screenshot?, screenshotSource? })`, `discard()`, `recordError()`, `isActive()`, and `stop()`. Supply a summary and reproduction steps by default; a host may explicitly set `require_steps=false`. A custom Blade integration must implement screenshot preview and confirmation itself before passing a Blob. The core entry point imports no Vue code, though the npm package declares Vue as a peer for the Vue integration.

### Example: Laravel 9 through 13 + Blade

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
composer require tracebug/laravel:0.2.0
php artisan vendor:publish --tag=tracebug-config
npm install github:CalvinChong123/TraceBug#v0.2.0
```

Enable only your test admin/user ID in `.env`:

```dotenv
TRACEBUG_ENABLED=true
TRACEBUG_ALLOWED_USERS=1
TRACEBUG_RELEASE=your-deployment-commit
```

Append `\TraceBug\Http\RecordRequest::class` to the `web` middleware group as described above: use `app/Http/Kernel.php` on Laravel 9/10 or `bootstrap/app.php` on Laravel 11–13.

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
          if (!summary) { client.discard(); return; }
          const steps = window.prompt('How can a developer reproduce it?')?.trim();
          if (!steps) { client.discard(); return; }
          const reportId = await client.report({ summary, steps });
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

PHP feature tests cover authorization, closed schemas, image re-encoding, idempotency, optional context, rate limits and pruning. JavaScript tests cover memory-only evidence, non-mutating requests, retries, discard, rollback and Vue root ownership. Browser tests cover CSP, a separate-origin API without added headers, iframe capture fallback, cancellation and screenshot review in Chromium and mobile-emulated WebKit. WebKit emulation is not a substitute for testing on a physical iPhone/Safari deployment.

Known limitations: Native tab capture requires a secure context, browser support, a user gesture and a fresh browser permission prompt. The browser picker may offer other tabs, so QA must choose this tab and verify the preview. Mobile browsers may not expose tab capture; paste/upload remains available. Only events after initialization are observed. CSS background-image failures and all browser network causes cannot be reliably identified. A hung JS thread cannot service a Report click. Minified Vue errors do not resolve to original source without an external source-map workflow. AJAX timings measure response-header availability for Fetch, not complete response-body download. No offline queue, issue tracker, dashboard or automatic reporting is included.

## Production configuration example

After tagging this reviewed source as `v0.2.0`, pin both Composer and npm dependencies to that tag. In the Laravel host:

```dotenv
TRACEBUG_ENABLED=true
TRACEBUG_ALLOWED_USERS=12,34
TRACEBUG_RELEASE=your-deployment-commit
TRACEBUG_SCREENSHOTS_ENABLED=false
```

In published `config/tracebug.php`, keep these hardened settings:

```php
'middleware' => ['web'],
'guard' => null,
'gate' => null, // Or a named Gate ability, defined by the host.
'screenshots_enabled' => false,
'require_steps' => true,
'slow_request_ms' => 1500,
'record_server_context' => false,
'correlation_headers_enabled' => false,
'storage_path' => storage_path('logs/tracebug'),
'retention_days' => 30,
'max_reports' => 1000,
```

Render the eligibility meta flag and CSRF token in the authenticated Blade layout as shown in Quick start. Install the Vue plugin once in the persistent root. Confirm the report route is covered by the host's session and CSRF middleware. Run and schedule `php artisan tracebug:prune` daily; check scheduler logs and enforce backup retention. Restrict `storage/logs/tracebug` to the application service account, including NTFS ACLs on Windows. Verify the report path is not publicly served or symlinked. Confirm the host's CSP allows its built asset and own API connection; test separately if the frontend and API have different origins. Keep screenshot capture off on sensitive pages.

To authorize by role instead of numeric IDs, leave the ID list empty, define `Gate::define('tracebug-reviewer', fn ($user) => $user->hasRole('developer'));` in the host, and set `'gate' => 'tracebug-reviewer'` in the published config. The ID list and Gate are alternatives; either may authorize. Never use an empty list with an undefined Gate and expect the widget to appear.

## Upgrade notes from v0.1.7

This release intentionally changes security-sensitive defaults and the report wire contract:

- Empty `allowed_users` now denies access; configure IDs or a Gate.
- Passive browser events are memory-only; same-tab reload recovery is removed.
- `record_server_context` is false by default. Existing `RecordRequest` middleware becomes inert until explicitly enabled.
- Screenshots require `TRACEBUG_SCREENSHOTS_ENABLED=true`; the server re-encodes all accepted images as WebP and needs GD for that feature.
- Reproduction steps are required unless `require_steps=false` is explicitly set.
- Fetch/XHR correlation headers are off unless both server and client advanced switches are enabled. The default never adds a preflight to application requests.
- Full URL path values, custom click labels, error messages, console arguments, and raw user-agent strings are no longer report evidence. Unknown nested report properties now return 422.
- Successful reports contain `complete.json` and a payload digest. Old reports without that marker remain readable by `tracebug:show`, but a retry to their ID returns 409 rather than assuming completion.
- `tracebug.log` is no longer written. `tracebug:prune` removes any legacy copy. Report listing scans retained report folders.
- New reports use a keyed `user_ref` instead of storing the raw authentication identifier. Older report files are not rewritten; prune them under the host's retention policy.
- Only one Vue root may install the plugin at a time. Installing in another root throws an explicit error.
- A configured existing storage directory must already be private and dedicated; TraceBug no longer changes its permissions on startup.

Review existing custom `redact`, `captureMessages`, screenshot and correlation options. `captureMessages` remains accepted but has no effect. The browser widget and Laravel package must be upgraded together because the new policy fields and stricter server schema are intentional breaking changes.
