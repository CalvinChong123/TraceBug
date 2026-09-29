<?php

return [
    'enabled' => (bool) env('TRACEBUG_ENABLED', false),
    // Empty means nobody. Define an ID allowlist or a Gate ability.
    'allowed_users' => array_values(array_filter(array_map('trim', explode(',', env('TRACEBUG_ALLOWED_USERS', ''))), fn ($id) => $id !== '')),
    'gate' => env('TRACEBUG_GATE'),
    'guard' => null,
    'middleware' => ['web'], // For Sanctum APIs use ['api', 'auth:sanctum'].
    'prefix' => '_tracebug',
    'storage_path' => storage_path('logs/tracebug'),
    'release' => env('TRACEBUG_RELEASE'),
    'retention_days' => 30,
    'context_ttl_seconds' => 300,
    'max_payload_bytes' => 131072,
    'max_screenshot_kb' => 2048,
    'reports_per_minute' => 6,
    'max_reports' => 1000,
    'screenshots_enabled' => (bool) env('TRACEBUG_SCREENSHOTS_ENABLED', false),
    'require_steps' => true,
    'slow_request_ms' => 1500,
    // Advanced opt-ins. Server context writes files before a report exists.
    'record_server_context' => false,
    'correlation_headers_enabled' => false,
    // Applied on top of built-in redaction. Use valid PCRE patterns.
    'redact_patterns' => [],
];
