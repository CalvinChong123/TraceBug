<?php

namespace TraceBug\Http;

use Closure;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Throwable;
use TraceBug\Access;
use TraceBug\PrivateStore;
use TraceBug\Redactor;

class RecordRequest
{
    public function handle(Request $request, Closure $next): mixed
    {
        $access = app(Access::class);
        if (! $access->allows($request) || $request->is(trim(config('tracebug.prefix'), '/').'/*')) {
            return $next($request);
        }

        $id = (string) Str::uuid();
        $started = microtime(true);
        $exception = null;
        try {
            $response = $next($request);
        } catch (Throwable $error) {
            $exception = $error;
            $handler = app(ExceptionHandler::class);
            $handler->report($error);
            $response = $handler->render($request, $error);
        }
        // Laravel may already have rendered an exception inside the routing pipeline.
        $exception ??= $response->exception ?? null;
        $response->headers->set('X-Request-ID', $id);

        // Diagnostic failures must never break the application's response.
        try {
            $redactor = app(Redactor::class);
            $context = [
                'request_id' => $id,
                'method' => $request->method(),
                'route' => $request->route()?->uri(),
                'status' => $response->getStatusCode(),
                'timestamp' => now()->toIso8601String(),
                'duration_ms' => round((microtime(true) - $started) * 1000),
                'exception' => $exception ? array_filter([
                    'class' => get_class($exception),
                    'message' => config('tracebug.include_exception_messages') ? $redactor->text($exception->getMessage()) : null,
                    'file' => str_replace(base_path().DIRECTORY_SEPARATOR, '', $exception->getFile()),
                    'line' => $exception->getLine(),
                ]) : null,
            ];
            $cache = app(PrivateStore::class)->cache();
            $scope = $access->scope($request);
            $ttl = config('tracebug.context_ttl_seconds');
            $cache->put($scope.':'.$id, $context, $ttl);
            $client = $request->header('X-TraceBug-ID');
            if (is_string($client) && Str::isUuid($client)) {
                $cache->put($scope.':'.$client, $context, $ttl);
            }
        } catch (Throwable) {
            // Report submission will show missing context, without changing app behavior.
        }

        return $response;
    }
}
