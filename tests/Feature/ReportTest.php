<?php

namespace TraceBug\Tests\Feature;

use Illuminate\Auth\GenericUser;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Gate;
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
            'qa' => ['summary' => 'Fixture bug report', 'steps' => 'Click Save'],
            'events' => [], 'ui' => [], 'screenshot_status' => 'disabled', 'screenshot_source' => 'none',
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

    public function test_empty_allowlist_fails_closed(): void
    {
        config(['tracebug.allowed_users' => []]);
        $this->getJson('/_tracebug/config')->assertJsonPath('enabled', false);
        $this->user(99)->getJson('/_tracebug/config')->assertJsonPath('enabled', false);
    }

    public function test_report_is_private_redacted_and_retry_is_idempotent(): void
    {
        $this->user();
        $this->upload($this->payload(['events' => [['id' => 'e1', 'at' => 1000, 'type' => 'error', 'data' => ['headers' => ['Authorization' => 'secret']]]]]))->assertUnprocessable();
        $payload = $this->payload(['events' => [['id' => 'e1', 'at' => 1000, 'type' => 'navigation', 'data' => ['url' => '/orders/123?token=secret']]]]);
        $id = $this->upload($payload)->assertCreated()->json('report_id');
        $this->upload($payload)->assertOk()->assertJsonPath('report_id', $id)->assertJsonPath('duplicate', true);
        $folder = $this->storage.'/reports/'.$id;
        $json = file_get_contents($folder.'/report.json');
        $this->assertStringNotContainsString('hunter2', $json);
        $this->assertStringNotContainsString('alice@example.com', $json);
        $this->assertStringNotContainsString('Authorization', $json);
        $this->assertSame('/:segment/:segment', json_decode($json, true)['page']['url']);
        $this->assertCount(1, glob($this->storage.'/reports/TB-*'));
        foreach (['report.log', 'network.json', 'console.json', 'ui-diagnostics.json'] as $file) $this->assertFileExists($folder.'/'.$file);
        $this->assertFileDoesNotExist($folder.'/screenshot.webp');
    }

    public function test_qa_summary_is_searchable_and_redacted_before_storage(): void
    {
        $this->user();
        $id = $this->upload($this->payload(['qa' => [
            'summary' => 'Order total did not update for alice@example.com',
            'steps' => 'Open order and click Save',
            'expected' => 'New total',
            'actual' => 'Old total',
        ], 'screenshot_source' => 'none']))->assertCreated()->json('report_id');
        $folder = $this->storage.'/reports/'.$id;
        $report = json_decode(file_get_contents($folder.'/report.json'), true);
        $this->assertSame('Order total did not update for [email]', $report['qa']['summary']);
        $this->assertStringContainsString('Summary: Order total did not update for [email]', file_get_contents($folder.'/report.log'));
        $this->assertFileDoesNotExist($this->storage.'/tracebug.log');
        $this->artisan('tracebug:list')->assertSuccessful();
        $this->upload($this->payload(['qa' => ['summary' => '  ']]))->assertUnprocessable();
        $this->upload($this->payload(['qa' => []]))->assertUnprocessable();
        $this->upload($this->payload(['screenshot_source' => null]))->assertUnprocessable();
        $this->upload($this->payload(['screenshot_source' => 'browser']))->assertUnprocessable();
    }

    public function test_request_context_links_by_client_id_and_is_user_scoped(): void
    {
        config(['tracebug.record_server_context' => true]);
        config(['tracebug.allowed_users' => ['1', '2']]);
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
        config(['tracebug.record_server_context' => true]);
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
        config(['tracebug.screenshots_enabled' => true]);
        $this->user();
        $this->upload($this->payload(['screenshot_status' => 'captured']))->assertUnprocessable();
        $pixel = imagecreatetruecolor(1, 1);
        ob_start(); imagepng($pixel); $png = ob_get_clean(); imagedestroy($pixel);
        $id = $this->post('/_tracebug/reports', ['payload' => json_encode($this->payload(['screenshot_status' => 'captured', 'screenshot_source' => 'upload'])), 'screenshot' => UploadedFile::fake()->createWithContent('screenshot.png', $png)], ['Accept' => 'application/json'])->assertCreated()->json('report_id');
        $this->assertFileExists($this->storage.'/reports/'.$id.'/screenshot.webp');
        $this->assertStringContainsString('Screenshot file: '.str_replace('\\', '/', $this->storage).'/reports/'.$id.'/screenshot.webp', str_replace('\\', '/', file_get_contents($this->storage.'/reports/'.$id.'/report.log')));
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
        $this->user()->getJson('/fixture')->assertOk()->assertHeaderMissing('X-Request-ID');
        $this->assertDirectoryDoesNotExist($this->storage);
        $this->assertDirectoryDoesNotExist($this->storage.'/reports');
        $this->assertFileDoesNotExist($this->storage.'/tracebug.log');
    }

    public function test_server_context_expires(): void
    {
        config(['tracebug.record_server_context' => true]);
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
        $mode = fileperms(public_path()) & 0777;
        config(['tracebug.storage_path' => public_path()]);
        $this->getJson('/fixture')->assertOk();
        $this->upload($this->payload())->assertStatus(500);
        clearstatcache(true, public_path());
        $this->assertSame($mode, fileperms(public_path()) & 0777);
        $nested = public_path('tracebug-should-not-create');
        config(['tracebug.storage_path' => $nested]);
        $this->upload($this->payload())->assertStatus(500);
        $this->assertDirectoryDoesNotExist($nested);
        config(['tracebug.storage_path' => base_path()]);
        $this->upload($this->payload())->assertStatus(500);
        config(['tracebug.storage_path' => storage_path('logs')]);
        $this->upload($this->payload())->assertStatus(500);
    }

    public function test_existing_shared_directory_is_never_chmodded(): void
    {
        if (DIRECTORY_SEPARATOR !== '/') $this->markTestSkipped('POSIX permission check.');
        mkdir($this->storage, 0755, true);
        chmod($this->storage, 0755);
        config(['tracebug.storage_path' => $this->storage]);
        $this->user();
        $this->upload($this->payload())->assertStatus(500);
        clearstatcache(true, $this->storage);
        $this->assertSame(0755, fileperms($this->storage) & 0777);
    }

    public function test_show_rejects_a_symlinked_report_file(): void
    {
        $this->user();
        $id = $this->upload($this->payload())->assertCreated()->json('report_id');
        $outside = $this->storage.'/outside.log';
        file_put_contents($outside, 'outside content');
        $link = $this->storage.'/reports/'.$id.'/report.log';
        unlink($link);
        if (! @symlink($outside, $link)) $this->markTestSkipped('Symlink creation unavailable.');
        try {
            $this->artisan('tracebug:show', ['id' => $id])->assertFailed();
        } finally {
            unlink($link);
        }
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

    public function test_gate_can_authorize_when_the_id_allowlist_is_empty(): void
    {
        config(['tracebug.allowed_users' => [], 'tracebug.gate' => 'tracebug-reviewer']);
        Gate::define('tracebug-reviewer', fn ($user) => (string) $user->getAuthIdentifier() === '2');
        $this->user(1)->getJson('/_tracebug/config')->assertJsonPath('enabled', false);
        $this->user(2)->getJson('/_tracebug/config')->assertJsonPath('enabled', true);
    }

    public function test_broken_gate_and_missing_app_key_fail_closed(): void
    {
        config(['tracebug.allowed_users' => [], 'tracebug.gate' => 'broken-tracebug-gate']);
        Gate::define('broken-tracebug-gate', fn () => throw new \RuntimeException('host policy failed'));
        $this->user()->getJson('/_tracebug/config')->assertJsonPath('enabled', false);
        config(['tracebug.allowed_users' => ['1'], 'tracebug.gate' => null, 'app.key' => '']);
        $this->getJson('/_tracebug/config')->assertJsonPath('enabled', false);
    }

    public function test_nested_unknown_fields_and_missing_steps_are_rejected(): void
    {
        $this->user();
        $this->upload($this->payload(['qa' => ['summary' => 'Save failed']]))->assertUnprocessable();
        $this->upload($this->payload(['ui' => ['card_number' => '4111 1111 1111 1111']]))->assertUnprocessable();
        $this->upload($this->payload(['events' => [['id' => 'e', 'at' => 1, 'type' => 'network', 'data' => ['headers' => ['cookie' => 'private']]]]]))->assertUnprocessable();
        $this->upload($this->payload(['events' => [['id' => 'e', 'at' => 1, 'type' => 'error', 'data' => ['frames' => [['url' => '/app.js', 'secret' => 'private']]]]]]))->assertUnprocessable();
        $this->assertDirectoryDoesNotExist($this->storage.'/reports');
        config(['tracebug.require_steps' => false]);
        $this->upload($this->payload(['qa' => ['summary' => 'Save failed'], 'events' => [[
            'id' => 'broken-image', 'at' => 1, 'type' => 'error', 'data' => ['name' => 'ImageLoadError', 'source_url' => '/private/image.png'],
        ]]]))->assertCreated();
    }

    public function test_idempotency_requires_matching_payload_and_completion_marker(): void
    {
        $this->user();
        $payload = $this->payload();
        $id = $this->upload($payload)->assertCreated()->json('report_id');
        $this->assertFileExists($this->storage.'/reports/'.$id.'/complete.json');
        $this->upload($payload)->assertOk()->assertJsonPath('duplicate', true);
        $this->upload(array_replace_recursive($payload, ['qa' => ['summary' => 'A changed summary']]))->assertStatus(409);
        unlink($this->storage.'/reports/'.$id.'/complete.json');
        $this->upload($payload)->assertStatus(409);
    }

    public function test_screenshots_are_disabled_by_default_and_reencoded_without_metadata(): void
    {
        $this->user();
        $image = imagecreatetruecolor(2, 2);
        ob_start(); imagejpeg($image); $jpeg = ob_get_clean(); imagedestroy($image);
        $jpeg .= 'GPSDATA';
        $fields = ['payload' => json_encode($this->payload(['screenshot_status' => 'captured', 'screenshot_source' => 'upload'])),
            'screenshot' => UploadedFile::fake()->createWithContent('screen.jpg', $jpeg)];
        $this->post('/_tracebug/reports', $fields, ['Accept' => 'application/json'])->assertUnprocessable();
        config(['tracebug.screenshots_enabled' => true]);
        $id = $this->post('/_tracebug/reports', $fields, ['Accept' => 'application/json'])->assertCreated()->json('report_id');
        $saved = file_get_contents($this->storage.'/reports/'.$id.'/screenshot.webp');
        $this->assertStringNotContainsString('GPSDATA', $saved);
        $this->assertSame('image/webp', getimagesizefromstring($saved)['mime']);
    }

    public function test_prune_removes_pending_folders_and_legacy_index(): void
    {
        $this->user();
        $id = $this->upload($this->payload())->assertCreated()->json('report_id');
        touch($this->storage.'/reports/'.$id.'/report.json', time() - 40 * 86400);
        $pending = $this->storage.'/reports/.pending-old';
        mkdir($pending);
        touch($pending, time() - 2 * 86400);
        file_put_contents($this->storage.'/tracebug.log', 'legacy private summary');
        $this->artisan('tracebug:prune', ['--days' => 30])->assertSuccessful();
        $this->assertDirectoryDoesNotExist($pending);
        $this->assertFileDoesNotExist($this->storage.'/tracebug.log');
        $this->assertDirectoryDoesNotExist($this->storage.'/reports/'.$id);
    }

    public function test_report_count_cap_rejects_new_reports_but_allows_exact_retry(): void
    {
        $this->user();
        config(['tracebug.max_reports' => 1]);
        $payload = $this->payload();
        $this->upload($payload)->assertCreated();
        $this->upload($payload)->assertOk()->assertJsonPath('duplicate', true);
        $this->upload($this->payload())->assertStatus(507);
    }

    public function test_email_auth_identifier_is_not_written_to_report(): void
    {
        config(['tracebug.allowed_users' => ['alice@example.com']]);
        $this->actingAs(new GenericUser(['id' => 'alice@example.com']));
        $id = $this->upload($this->payload())->assertCreated()->json('report_id');
        $json = file_get_contents($this->storage.'/reports/'.$id.'/report.json');
        $this->assertStringNotContainsString('alice@example.com', $json);
        $this->assertArrayHasKey('user_ref', json_decode($json, true));
    }

    public function test_free_text_urls_and_spaced_card_numbers_are_redacted(): void
    {
        $this->user();
        $id = $this->upload($this->payload(['qa' => [
            'summary' => 'Failed at https://example.test/reset/shortToken?token=secret',
            'steps' => 'Enter 4111 1111 1111 1111 then Save',
        ]]))->assertCreated()->json('report_id');
        $json = file_get_contents($this->storage.'/reports/'.$id.'/report.json');
        $this->assertStringNotContainsString('shortToken', $json);
        $this->assertStringNotContainsString('4111 1111 1111 1111', $json);
        $this->assertStringContainsString('[url]', $json);
    }
}
