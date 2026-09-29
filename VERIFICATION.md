# TraceBug v0.2.0 hardening verification

The current source is not yet tagged or published. Verify the release ref in both Composer and npm before deployment.

Local checks on PHP 8.2.21 and Node 20.19.6:

- `composer validate --strict`
- `composer test` — includes authorization, CSRF in a web-stack fixture, closed report fields, image re-encoding, idempotency, and pruning.
- `npm run typecheck`
- `npm test` — includes memory-only buffering, non-mutating requests, rollback, outcome handling, and Vue root ownership.
- `npm run build`
- `npx playwright test` — includes strict CSP, cross-origin header-free requests, iframe fallback, cancellation, and screenshot review in Chromium and emulated WebKit.

The POSIX permission-mode regression test is skipped on Windows. The report-file symlink test also skips when Windows denies symlink creation; both run in the Linux CI matrix. Native tab capture and permission-denial checks are skipped in emulated mobile WebKit, which does not expose the desktop capture API.

CI continues to exercise Laravel 9 through 13 on its PHP compatibility matrix. The browser fixture mocks report endpoints; the PHP suite exercises Laravel request handling. Neither substitutes for staging validation of the consuming application's actual auth/session setup, NTFS or Unix file permissions, CORS, CSP, scheduler, real browser picker, backup retention, and mobile Safari behavior.
