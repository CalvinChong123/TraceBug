# TraceBug v0.1.7 verification

Local Windows checks on PHP 8.2.21:

- `composer validate --strict`: valid manifest.
- `composer test`: 15 feature tests, 74 assertions passing on Laravel 12.
- `composer update --lock`: no reported security advisories.

The GitHub Actions workflow tests Laravel 9 on PHP 8.0, Laravel 10 on PHP 8.1, Laravel 11 and 12 on PHP 8.2, and Laravel 13 on PHP 8.3. It also checks the Vue package with TypeScript, Vitest, production build, and Playwright. Check the latest workflow run for the release result. CI disables Composer's advisory blocker only in the end-of-life Laravel 9–11 jobs so their compatibility tests can resolve dependencies; consuming applications keep their own Composer security policy.

A separate Composer consumer manifest installed `tracebug/laravel` v0.1.7 from the public GitHub tag with Laravel 9.52.22. Composer 2.10.3 then reproduced the advisory blocker on a fresh update; a Laravel-9-scoped `policy.advisories.ignore` rule with `on-audit: false` allowed resolution while still reporting the advisories.

The browser fixture mocks HTTP endpoints; backend request handling is exercised separately with Laravel Testbench. A consuming application's session and auth configuration, CSP, custom CSS, and physical Safari/iPhone behavior still need integration testing.
