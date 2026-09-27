# TraceBug v0.1.6 verification

Local Windows checks on PHP 8.2.21:

- `composer validate --strict`: valid manifest.
- `composer test`: 15 feature tests, 74 assertions passing on Laravel 12.
- `composer update --lock`: no reported security advisories.

The GitHub Actions workflow tests Laravel 12 on PHP 8.2 and Laravel 13 on PHP 8.3. It also checks the Vue package with TypeScript, Vitest, production build, and Playwright. Check the latest workflow run for the release result.

The browser fixture mocks HTTP endpoints; backend request handling is exercised separately with Laravel Testbench. A consuming application's session and auth configuration, CSP, custom CSS, and physical Safari/iPhone behavior still need integration testing.
