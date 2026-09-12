<?php

namespace TraceBug\Tests\Feature;

use Illuminate\Auth\GenericUser;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use Orchestra\Testbench\TestCase;
use TraceBug\Http\RecordRequest;
use TraceBug\TraceBugServiceProvider;

class ReportTest extends TestCase
{
    private string $storage;

    protected function getPackageProviders($app): array
    {
        return [TraceBugServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $this->storage = dirname(__DIR__, 2).'/test-output/'.Str::uuid();
        $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('a', 32)));
        $app['config']->set('tracebug.enabled', true);
        $app['config']->set('tracebug.storage_path', $this->storage);
        $app['config']->set('tracebug.allowed_users', ['1']);
        $app['config']->set('tracebug.middleware', ['api']);
        $app['config']->set('tracebug.reports_per_minute', 60);
    }

    protected function defineRoutes($router): void
    {
        Route::middleware(RecordRequest::class)->get('/fixture', fn () => response()->json(['ok' => true]));
        Route::middleware(RecordRequest::class)->post('/failure', fn () => throw new \RuntimeException('password=hunter2 alice@example.com'));
    }

    protected function tearDown(): void
    {
        (new \Illuminate\Filesystem\Filesystem)->deleteDirectory($this->storage);
        parent::tearDown();
    }

    private function user(int $id = 1): self
    {
        return $this->actingAs(new GenericUser(['id' => $id]));
    }

    private function payload(array $replace = []): array
    {
        return array_replace([
            'schema_version' => 1,
            'submission_id' => (string) Str::uuid(),
            'captured_at' => now()->toIso8601String(),
            'page' => ['url' => 'https://example.test/orders/123?token=secret#private'],
            'events' => [], 'ui' => [], 'screenshot_status' => 'failed',
        ], $replace);
    }

    private function upload(array $payload)
    {
        return $this->postJson('/_tracebug/reports', ['payload' => json_encode($payload)]);
    }

    public function test_disabled_and_guest_access_create_no_storage(): void
    {
        $this->getJson('/_tracebug/config')->assertExactJson(['enabled' => false]);
        $this->upload($this->payload())->assertNotFound();
        $this->user();
        config(['tracebug.enabled' => false]);
        $this->getJson('/_tracebug/config')->assertExactJson(['enabled' => false]);
        $this->upload($this->payload())->assertNotFound();
        $this->assertDirectoryDoesNotExist($this->storage);
    }

    public function test_allowed_users_are_not_exposed_and_unauthorized_user_is_denied(): void
    {
        $this->user(2)->getJson('/_tracebug/config')->assertExactJson(['enabled' => false]);
        $this->upload($this->payload())->assertNotFound();
        $response = $this->user()->getJson('/_tracebug/config')->assertJsonPath('enabled', true)->assertHeader('Cache-Control', 'no-store, private');
        $this->assertArrayNotHasKey('allowed_users', $response->json());
    }

    public function test_empty_allowlist_still_requires_authentication(): void
    {
        config(['tracebug.allowed_users' => []]);
        $this->getJson('/_tracebug/config')->assertJsonPath('enabled', false);
        $this->user(99)->getJson('/_tracebug/config')->assertJsonPath('enabled', true);
    }

    public function test_report_is_private_redacted_and_retry_is_idempotent(): void
    {
        $this->user();
        $payload = $this->payload(['events' => [['id' => 'e1', 'at' => 1000, 'type' => 'error', 'data' => ['message' => 'password=hunter2 alice@example.com', 'headers' => ['Authorization' => 'secret'], 'body' => 'secret']]]]);
        $id = $this->upload($payload)->assertCreated()->json('report_id');
        $this->upload($payload)->assertOk()->assertJsonPath('report_id', $id)->assertJsonPath('duplicate', true);
        $folder = $this->storage.'/reports/'.$id;
        $json = file_get_contents($folder.'/report.json');
        $this->assertStringNotContainsString('hunter2', $json);
        $this->assertStringNotContainsString('alice@example.com', $json);
        $this->assertStringNotContainsString('Authorization', $json);
        $this->assertSame('/orders/:id', json_decode($json, true)['page']['url']);
        $this->assertCount(1, glob($this->storage.'/reports/TB-*'));
        foreach (['report.log', 'network.json', 'console.json', 'ui-diagnostics.json'] as $file) $this->assertFileExists($folder.'/'.$file);
        $this->assertFileDoesNotExist($folder.'/screenshot.webp');
    }

    public function test_request_context_links_by_client_id_and_is_user_scoped(): void
    {
        config(['tracebug.allowed_users' => []]);
        $this->user();
        $client = (string) Str::uuid();
        $requestId = $this->withHeader('X-TraceBug-ID', $client)->getJson('/fixture')->assertOk()->headers->get('X-Request-ID');
        $this->assertTrue(Str::isUuid($requestId));
        $event = ['id' => 'e1', 'at' => 1000, 'type' => 'network', 'data' => ['client_id' => $client, 'state' => 'timeout']];
        $id = $this->upload($this->payload(['events' => [$event]]))->assertCreated()->json('report_id');
        $report = json_decode(file_get_contents($this->storage.'/reports/'.$id.'/report.json'), true);
        $this->assertSame($requestId, $report['server_requests'][0]['request_id']);
        $this->user(2);
        $id = $this->upload($this->payload(['events' => [$event]]))->assertCreated()->json('report_id');
        $report = json_decode(file_get_contents($this->storage.'/reports/'.$id.'/report.json'), true);
        $this->assertSame([], $report['server_requests']);
    }

    public function test_exception_context_is_recorded_without_message_by_default(): void
    {
        $this->user();
        $response = $this->postJson('/failure')->assertStatus(500);
        $requestId = $response->headers->get('X-Request-ID');
        $id = $this->upload($this->payload(['events' => [['id' => 'e', 'at' => 1, 'type' => 'network', 'data' => ['request_id' => $requestId]]]]))->assertCreated()->json('report_id');
        $report = json_decode(file_get_contents($this->storage.'/reports/'.$id.'/report.json'), true);
        $this->assertSame(\RuntimeException::class, $report['server_requests'][0]['exception']['class']);
        $this->assertArrayNotHasKey('message', $report['server_requests'][0]['exception']);
    }

    public function test_malformed_oversized_and_unexpected_payloads_are_rejected(): void
    {
        $this->user();
        $this->postJson('/_tracebug/reports', ['payload' => '{invalid'])->assertUnprocessable();
        $this->postJson('/_tracebug/reports', ['payload' => 'null'])->assertUnprocessable();
        $this->upload($this->payload(['submission_id' => '../escape']))->assertUnprocessable();
        $this->upload($this->payload(['page' => ['url' => '/', 'password' => 'secret']]))->assertUnprocessable();
        $this->upload($this->payload(['events' => array_fill(0, 51, ['id' => 'x', 'at' => 1, 'type' => 'error', 'data' => ['name' => 'Error']])]))->assertUnprocessable();
        $this->postJson('/_tracebug/reports', ['payload' => str_repeat('a', 131073)])->assertUnprocessable();
    }

    public function test_valid_image_is_saved_and_status_mismatch_is_rejected(): void
    {
        $this->user();
        $this->upload($this->payload(['screenshot_status' => 'captured']))->assertUnprocessable();
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==');
        $id = $this->post('/_tracebug/reports', ['payload' => json_encode($this->payload(['screenshot_status' => 'captured'])), 'screenshot' => UploadedFile::fake()->createWithContent('screenshot.png', $png)], ['Accept' => 'application/json'])->assertCreated()->json('report_id');
        $this->assertFileExists($this->storage.'/reports/'.$id.'/screenshot.png');
    }

    public function test_prune_dry_run_and_show_path_validation(): void
    {
        $this->user();
        $id = $this->upload($this->payload())->assertCreated()->json('report_id');
        $path = $this->storage.'/reports/'.$id.'/report.json';
        touch($path, time() - 40 * 86400);
        $this->artisan('tracebug:prune', ['--days' => 30, '--dry-run' => true])->assertSuccessful();
        $this->assertFileExists($path);
        $this->artisan('tracebug:show', ['id' => '../../secret'])->assertFailed();
        $this->artisan('tracebug:show', ['id' => $id])->assertSuccessful();
        $this->artisan('tracebug:prune', ['--days' => 30])->assertSuccessful();
        $this->assertFileDoesNotExist($path);
    }

    public function test_rate_limit_is_enforced(): void
    {
        $this->user();
        config(['tracebug.reports_per_minute' => 1]);
        $this->upload($this->payload())->assertCreated();
        $this->upload($this->payload())->assertStatus(429);
    }

    public function test_recording_without_submission_creates_no_report(): void
    {
        $this->user()->getJson('/fixture')->assertOk()->assertHeader('X-Request-ID');
        $this->assertDirectoryDoesNotExist($this->storage.'/reports');
        $this->assertFileDoesNotExist($this->storage.'/tracebug.log');
    }

    public function test_server_context_expires(): void
    {
        $this->user();
        $requestId = $this->getJson('/fixture')->headers->get('X-Request-ID');
        $this->travel(6)->minutes();
        $id = $this->upload($this->payload(['events' => [['id' => 'e', 'at' => 1, 'type' => 'network', 'data' => ['request_id' => $requestId]]]]))->assertCreated()->json('report_id');
        $report = json_decode(file_get_contents($this->storage.'/reports/'.$id.'/report.json'), true);
        $this->assertSame([], $report['server_requests']);
        $this->travelBack();
    }

    public function test_public_storage_is_rejected_without_breaking_application_requests(): void
    {
        $this->user();
        config(['tracebug.storage_path' => public_path()]);
        $this->getJson('/fixture')->assertOk();
        $this->upload($this->payload())->assertStatus(500);
    }

    public function test_same_user_different_sessions_cannot_read_context(): void
    {
        $user = new GenericUser(['id' => 1]);
        $a = \Illuminate\Http\Request::create('/');
        $b = \Illuminate\Http\Request::create('/');
        $a->setUserResolver(fn () => $user);
        $b->setUserResolver(fn () => $user);
        $first = new \Illuminate\Session\Store('a', new \Illuminate\Session\ArraySessionHandler(120));
        $second = new \Illuminate\Session\Store('b', new \Illuminate\Session\ArraySessionHandler(120));
        $a->setLaravelSession($first);
        $b->setLaravelSession($second);
        $access = app(\TraceBug\Access::class);
        $this->assertNotSame($access->scope($a), $access->scope($b));
    }
}
