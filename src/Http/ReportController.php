<?php

namespace TraceBug\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use TraceBug\Access;
use TraceBug\PrivateStore;
use TraceBug\Redactor;

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
            ];
        }

        return response()->json($data)->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, Access $access, PrivateStore $store, Redactor $redactor): JsonResponse
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
        $data = validator($payload, [
            'schema_version' => ['required', 'integer', 'in:1'],
            'submission_id' => ['required', 'uuid'],
            'captured_at' => ['required', 'date'],
            'page' => ['required', 'array:url,viewport,screen,dpr,orientation,user_agent'],
            'page.url' => ['required', 'string', 'max:2048'],
            'events' => ['present', 'array', 'max:50'],
            'events.*' => ['array:id,at,type,data'],
            'events.*.id' => ['required', 'string', 'max:64'],
            'events.*.at' => ['required', 'numeric'],
            'events.*.type' => ['required', 'in:network,error,vue,console,navigation,click,submit'],
            'events.*.data' => ['required', 'array'],
            'ui' => ['present', 'array'],
            'screenshot_status' => ['required', 'in:captured,failed,timeout,disabled'],
        ])->validate();

        $extension = null;
        if ($image = $request->file('screenshot')) {
            $size = @getimagesize($image->getRealPath());
            if (! $size || $size[0] * $size[1] > 8000000) {
                throw ValidationException::withMessages(['screenshot' => 'Image exceeds the 8 megapixel limit or is invalid.']);
            }
            $extension = ['image/png' => 'png', 'image/webp' => 'webp', 'image/jpeg' => 'jpg'][$size['mime']] ?? null;
            abort_unless($extension, 422);
        }
        if (($data['screenshot_status'] === 'captured') !== ($extension !== null)) {
            throw ValidationException::withMessages(['screenshot' => 'Screenshot status does not match attachment.']);
        }

        $scope = $access->scope($request);
        $id = 'TB-'.strtoupper(substr(hash('sha256', $scope.':'.$data['submission_id']), 0, 32));
        $root = $store->root();
        $store->directory($root.'/reports');
        $target = $root.'/reports/'.$id;

        return $store->cache()->lock('report:'.$id, 30)->block(5, function () use ($request, $access, $store, $redactor, $data, $scope, $id, $root, $target, $extension, $image) {
            if (is_file($target.'/report.json')) {
                return response()->json(['report_id' => $id, 'duplicate' => true])->header('Cache-Control', 'no-store');
            }
            $data = $redactor->clean($data);
            $contexts = [];
            foreach ($data['events'] as $event) {
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
                'user_id' => (string) $access->user($request)->getAuthIdentifier(),
                'release' => config('tracebug.release'),
                'environment' => app()->environment(),
                'server_requests' => array_values($contexts),
                'screenshot_file' => $extension ? 'screenshot.'.$extension : null,
            ]);
            $temporary = $root.'/reports/.pending-'.Str::uuid();
            $store->directory($temporary);
            try {
                $json = fn ($value) => json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
                $store->write($temporary.'/report.json', $json($report));
                $summary = "$id\nReceived: {$report['received_at']}\nUser: {$report['user_id']}\nPage: {$report['page']['url']}\nEvents: ".count($report['events'])."\nRelated server requests: ".count($contexts)."\nScreenshot: {$report['screenshot_status']}\n";
                $store->write($temporary.'/report.log', $summary);
                $store->write($temporary.'/network.json', $json(array_values(array_filter($data['events'], fn ($e) => $e['type'] === 'network'))));
                $store->write($temporary.'/console.json', $json(array_values(array_filter($data['events'], fn ($e) => in_array($e['type'], ['error', 'vue', 'console'])))));
                $store->write($temporary.'/ui-diagnostics.json', $json($data['ui']));
                if ($extension) {
                    $store->write($temporary.'/screenshot.'.$extension, file_get_contents($image->getRealPath()));
                }
                if (! @rename($temporary, $target)) {
                    $filesystem = new \Illuminate\Filesystem\Filesystem;
                    if (is_dir($target) || ! $filesystem->copyDirectory($temporary, $target)) {
                        throw new \RuntimeException('Cannot finalize TraceBug report.');
                    }
                    $filesystem->deleteDirectory($temporary);
                }
            } finally {
                if (is_dir($temporary)) {
                    (new \Illuminate\Filesystem\Filesystem)->deleteDirectory($temporary);
                }
            }
            // The report is already committed. An index failure must not cause a duplicate.
            @file_put_contents($root.'/tracebug.log', json_encode(['report_id' => $id, 'timestamp' => $report['received_at'], 'user_id' => $report['user_id'], 'url' => $report['page']['url'], 'folder' => $target], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)."\n", FILE_APPEND | LOCK_EX);
            @chmod($root.'/tracebug.log', 0600);

            return response()->json(['report_id' => $id, 'duplicate' => false], 201)->header('Cache-Control', 'no-store');
        });
    }
}
