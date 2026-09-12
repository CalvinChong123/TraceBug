<?php

namespace TraceBug;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use TraceBug\Console\ReportsCommand;
use TraceBug\Http\Authorize;
use TraceBug\Http\ReportController;

class TraceBugServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/tracebug.php', 'tracebug');
    }

    public function boot(): void
    {
        $this->publishes([__DIR__.'/../config/tracebug.php' => config_path('tracebug.php')], 'tracebug-config');
        $this->commands([ReportsCommand::class, Console\ShowCommand::class, Console\PruneCommand::class]);
        RateLimiter::for('tracebug', function ($request) {
            // Laravel may prioritize throttling ahead of custom authorization middleware.
            $access = app(Access::class);
            abort_unless($access->allows($request), 404);
            return Limit::perMinute(config('tracebug.reports_per_minute'))->by($access->scope($request));
        });

        if (! $this->app->routesAreCached()) {
            Route::prefix(config('tracebug.prefix'))->middleware(config('tracebug.middleware'))->group(function () {
                Route::get('config', [ReportController::class, 'config'])->name('tracebug.config');
                Route::post('reports', [ReportController::class, 'store'])->middleware([Authorize::class, 'throttle:tracebug'])->name('tracebug.reports');
            });
        }
    }
}
