<?php

return [
    'enabled' => (bool) env('TRACEBUG_ENABLED', false),
    // Empty means all authenticated users; guests are always denied.
    'allowed_users' => array_values(array_filter(array_map('trim', explode(',', env('TRACEBUG_ALLOWED_USERS', ''))), fn ($id) => $id !== '')),
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
    // Messages can contain business data and are omitted unless explicitly enabled.
    'include_exception_messages' => false,
    // Applied on top of built-in redaction. Use valid PCRE patterns.
    'redact_patterns' => [],
];
