# TraceBug 0.1.0 verification

Verified locally on Windows with PHP 8.2.21 and Node 20.19.6.

- Laravel 12.69.2: 14 feature tests, 64 assertions passing.
- Laravel 11.56.1: initial 10 feature tests, 55 assertions passing; the four subsequently added feature cases were run on Laravel 12. The committed CI matrix runs the full suite on both versions.
- Vitest 4.1.11: 11 browser-core tests passing.
- Playwright: four tests passing against the built distribution in Chromium and mobile-emulated WebKit.
- TypeScript checking and production build passing.
- Built package exports load successfully without a browser (SSR import smoke check).
- Composer manifest validates; the final Laravel 12 development dependency set has no reported Composer advisories.
- npm audit reports no vulnerabilities in the final dependency set.
- npm tarball generated: `tracebug-vue-0.1.0.tgz` (approximately 65 KB compressed).

Browser verification covers a Vue Report button, disabled eligibility, failed Fetch and XHR requests, upload completion, horizontal overflow, and actual canvas masking. The private region's distinct source color is absent from the rendered pixels. The generated mobile screenshot was visually inspected; the input value and marked private block are masked.

The browser fixture mocks HTTP endpoints; backend request handling is exercised separately with Laravel Testbench. A consuming application's actual session/Sanctum setup, CSP, custom CSS, and physical Safari/iPhone behavior still require application integration testing. This package has not been installed into another application, published to registries, or deployed.

See README.md for installation, explicit privacy marking, middleware placement, scheduler setup, and limitations.
