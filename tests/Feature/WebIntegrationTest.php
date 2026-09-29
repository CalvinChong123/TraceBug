<?php

namespace TraceBug\Tests\Feature;

use Illuminate\Auth\GenericUser;
use Illuminate\Foundation\Http\Middleware\VerifyCsrfToken;
use Illuminate\Support\Str;
use Orchestra\Testbench\TestCase;
use TraceBug\TraceBugServiceProvider;

class ForceCsrf extends VerifyCsrfToken
{
    protected function runningUnitTests() { return false; }
}

/** Exercises the package route inside a consuming application's web stack. */
class WebIntegrationTest extends TestCase
{
    private string $storage;

    protected function getPackageProviders($app): array { return [TraceBugServiceProvider::class]; }

    protected function defineEnvironment($app): void
    {
        $this->storage = dirname(__DIR__, 2).'/test-output/'.Str::uuid();
        $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('b', 32)));
        $app['config']->set('tracebug.enabled', true);
        $app['config']->set('tracebug.allowed_users', ['7']);
        $app['config']->set('tracebug.middleware', ['web', ForceCsrf::class]);
        $app['config']->set('tracebug.storage_path', $this->storage);
    }

    protected function tearDown(): void
    {
        (new \Illuminate\Filesystem\Filesystem)->deleteDirectory($this->storage);
        parent::tearDown();
    }

    public function test_authentication_and_csrf_are_required_on_web_report_route(): void
    {
        $payload = json_encode(['schema_version' => 1, 'submission_id' => (string) Str::uuid(),
            'captured_at' => now()->toIso8601String(), 'page' => ['url' => '/orders/5'],
            'qa' => ['summary' => 'Save failed', 'steps' => 'Open order and click Save'],
            'events' => [], 'ui' => [], 'screenshot_status' => 'disabled', 'screenshot_source' => 'none']);
        $this->withSession(['_token' => 'csrf-secret']);
        $this->postJson('/_tracebug/reports', ['payload' => $payload], ['X-CSRF-TOKEN' => 'csrf-secret'])->assertNotFound();
        $this->actingAs(new GenericUser(['id' => 7]));
        $this->postJson('/_tracebug/reports', ['payload' => $payload])->assertStatus(419);
        $this->postJson('/_tracebug/reports', ['payload' => $payload], ['X-CSRF-TOKEN' => 'csrf-secret'])->assertCreated();
    }
}
