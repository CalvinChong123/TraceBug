<?php

namespace TraceBug\Console;

use Illuminate\Console\Command;
use Illuminate\Filesystem\Filesystem;
use TraceBug\PrivateStore;

class PruneCommand extends Command
{
    protected $signature = 'tracebug:prune {--days= : Defaults to configured retention} {--dry-run}';
    protected $description = 'Remove expired TraceBug reports and temporary context';

    public function handle(PrivateStore $store): int
    {
        $days = $this->option('days') ?? config('tracebug.retention_days');
        if (! ctype_digit((string) $days) || (int) $days < 1) {
            $this->error('Days must be a positive integer.');
            return self::FAILURE;
        }
        $root = $store->root();
        $cutoff = time() - (int) $days * 86400;
        foreach (glob($root.'/reports/*', GLOB_ONLYDIR) ?: [] as $folder) {
            if (is_link($folder) || ! preg_match('/^TB-[A-F0-9]{32}$/D', basename($folder))) {
                continue;
            }
            $file = $folder.'/report.json';
            if (is_file($file) && filemtime($file) < $cutoff) {
                $this->line(($this->option('dry-run') ? 'Would remove ' : 'Removing ').basename($folder));
                if (! $this->option('dry-run')) {
                    (new Filesystem)->deleteDirectory($folder);
                }
            }
        }
        // File cache expires lazily; remove old files so idle contexts do not accumulate.
        if (is_dir($root.'/context') && ! $this->option('dry-run')) {
            foreach ((new Filesystem)->allFiles($root.'/context') as $file) {
                if (! $file->isLink() && $file->getMTime() < time() - max(600, config('tracebug.context_ttl_seconds') * 2)) {
                    unlink($file->getPathname());
                }
            }
        }

        return self::SUCCESS;
    }
}
