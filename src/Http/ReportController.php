<?php

namespace TraceBug\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use TraceBug\Access;
use TraceBug\PrivateStore;
use TraceBug\Redactor;
use TraceBug\ReportSchema;
use TraceBug\ScreenshotSanitizer;

class ReportController
{
    public function config(Request $request, Access $access): JsonResponse
    {
        $data = ['enabled' => false];
        if ($access->allows($request)) {
            $data = [
                'enabled' => true,
                'scope' => $access->scope($request),
                'endpoint' => route('tracebug.reports', [], false),
                'release' => config('tracebug.release'),
                'screenshot_enabled' => (bool) config('tracebug.screenshots_enabled') && function_exists('imagecreatefromstring') && function_exists('imagewebp'),
                'require_steps' => (bool) config('tracebug.require_steps'),
                'slow_request_ms' => (int) config('tracebug.slow_request_ms'),
                'correlation_headers_enabled' => (bool) config('tracebug.correlation_headers_enabled'),
            ];
        }

        return response()->json($data)->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, Access $access, PrivateStore $store, Redactor $redactor, ReportSchema $schema, ScreenshotSanitizer $sanitizer): JsonResponse
    {
        $request->validate([
            'payload' => ['required', 'string', 'max:'.config('tracebug.max_payload_bytes')],
            'screenshot' => ['nullable', 'file', 'mimetypes:image/png,image/webp,image/jpeg', 'max:'.config('tracebug.max_screenshot_kb')],
        ]);
        abort_if(strlen($request->input('payload')) > config('tracebug.max_payload_bytes'), 413);
        try {
            $payload = json_decode($request->input('payload'), true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw ValidationException::withMessages(['payload' => 'Invalid report JSON.']);
        }
        if (! is_array($payload)) {
            throw ValidationException::withMessages(['payload' => 'Expected a report object.']);
        }
        $data = $schema->validate($payload);

        $extension = null;
        $imageBytes = null;
        if ($image = $request->file('screenshot')) {
            abort_unless(config('tracebug.screenshots_enabled'), 422);
            $imageBytes = $sanitizer->sanitize($image);
            $extension = 'webp';
        }
        if (($data['screenshot_status'] === 'captured') !== ($extension !== null)) {
            throw ValidationException::withMessages(['screenshot' => 'Screenshot status does not match attachment.']);
        }
        if (($extension && $data['screenshot_source'] === 'none') || (! $extension && $data['screenshot_source'] !== 'none')) {
            throw ValidationException::withMessages(['screenshot_source' => 'Screenshot source does not match attachment.']);
        }

        $scope = $access->scope($request);
        $digest = hash('sha256', $request->input('payload').':'.($image ? hash_file('sha256', $image->getRealPath()) : 'none'));
        $id = 'TB-'.strtoupper(substr(hash('sha256', $scope.':'.$data['submission_id']), 0, 32));
        $root = $store->root();
        $store->directory($root.'/reports');
        $target = $root.'/reports/'.$id;

        return $store->cache()->lock('report:'.$id, 30)->block(5, function () use ($request, $access, $store, $redactor, $data, $scope, $id, $root, $target, $extension, $imageBytes, $digest) {
            if (is_link($target)) abort(409, 'Report ID points to an unsafe path.');
            if (is_dir($target)) {
                $marker = ! is_link($target.'/complete.json') && is_file($target.'/complete.json') ? json_decode(file_get_contents($target.'/complete.json'), true) : null;
                if (($marker['digest'] ?? null) !== $digest || is_link($target.'/report.json') || ! is_file($target.'/report.json')) {
                    abort(409, 'Report ID already exists with different or incomplete content.');
                }
                return response()->json(['report_id' => $id, 'duplicate' => true])->header('Cache-Control', 'no-store');
            }
            if (count(glob($root.'/reports/TB-*', GLOB_ONLYDIR) ?: []) >= (int) config('tracebug.max_reports')) {
                abort(507, 'TraceBug report capacity reached. Run tracebug:prune.');
            }
            $data = $redactor->clean($data);
            foreach ($data['events'] as $index => &$event) $event['id'] = 'event-'.$index;
            unset($event);
            $contexts = [];
            foreach (config('tracebug.record_server_context') ? $data['events'] : [] as $event) {
                foreach (['request_id', 'client_id'] as $key) {
                    $requestId = $event['data'][$key] ?? null;
                    if (is_string($requestId) && Str::isUuid($requestId)) {
                        $context = $store->cache()->get($scope.':'.$requestId);
                        if ($context) {
                            $contexts[$context['request_id']] = $context;
                        }
                    }
                }
            }
            $report = array_merge($data, [
                'report_id' => $id,
                'received_at' => now()->toIso8601String(),
                'user_ref' => substr(hash_hmac('sha256', get_class($access->user($request)).':'.$access->user($request)->getAuthIdentifier(), (string) config('app.key')), 0, 16),
                'release' => config('tracebug.release'),
                'environment' => app()->environment(),
                'server_requests' => array_values($contexts),
                'screenshot_file' => $extension ? 'screenshot.'.$extension : null,
                'screenshot_source' => $data['screenshot_source'],
            ]);
            $temporary = $root.'/reports/.pending-'.Str::uuid();
            $store->directory($temporary);
            try {
                $json = fn ($value) => json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
                $store->write($temporary.'/report.json', $json($report));
                $overview = $report['qa']['summary'];
                $summary = "$id\nSummary: $overview\nReceived: {$report['received_at']}\nUser ref: {$report['user_ref']}\nPage: {$report['page']['url']}\nEvents: ".count($report['events'])."\nRelated server requests: ".count($contexts)."\nScreenshot: {$report['screenshot_status']} ({$report['screenshot_source']})\n";
                foreach (['steps' => 'Steps', 'expected' => 'Expected', 'actual' => 'Actual'] as $key => $label) {
                    if (! empty($report['qa'][$key])) $summary .= "$label: {$report['qa'][$key]}\n";
                }
                $summary .= "Report folder: $target\n";
                if ($extension) $summary .= "Screenshot file: $target/screenshot.$extension\n";
                $store->write($temporary.'/report.log', $summary);
                $store->write($temporary.'/network.json', $json(array_values(array_filter($data['events'], fn ($e) => $e['type'] === 'network'))));
                $store->write($temporary.'/console.json', $json(array_values(array_filter($data['events'], fn ($e) => in_array($e['type'], ['error', 'vue', 'console'])))));
                $store->write($temporary.'/ui-diagnostics.json', $json($data['ui']));
                if ($extension) $store->write($temporary.'/screenshot.'.$extension, $imageBytes);
                $store->write($temporary.'/complete.json', $json(['digest' => $digest]));
                if (! @rename($temporary, $target)) {
                    throw new \RuntimeException('Cannot finalize TraceBug report atomically.');
                }
            } finally {
                if (is_dir($temporary)) {
                    (new \Illuminate\Filesystem\Filesystem)->deleteDirectory($temporary);
                }
            }
            return response()->json(['report_id' => $id, 'duplicate' => false], 201)->header('Cache-Control', 'no-store');
        });
    }
}
