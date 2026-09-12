<?php

namespace TraceBug;

use Illuminate\Cache\FileStore;
use Illuminate\Cache\Repository;
use Illuminate\Filesystem\Filesystem;
use RuntimeException;

class PrivateStore
{
    public function root(): string
    {
        $path = rtrim(config('tracebug.storage_path'), '/\\');
        $this->directory($path);
        $real = realpath($path);
        $public = realpath(public_path());
        $normalizedReal = strtolower(str_replace('\\', '/', $real ?: ''));
        $normalizedPublic = strtolower(str_replace('\\', '/', $public ?: ''));
        if ($real === false || ($public && (strcasecmp($real, $public) === 0 || strpos($normalizedReal, $normalizedPublic.'/') === 0))) {
            throw new RuntimeException('TraceBug storage must be outside the public directory.');
        }

        return $real;
    }

    public function cache(): Repository
    {
        return new Repository(new FileStore(new Filesystem, $this->root().'/context', 0600));
    }

    public function directory(string $path): void
    {
        if (! is_dir($path) && ! @mkdir($path, 0700, true) && ! is_dir($path)) {
            throw new RuntimeException('Cannot create TraceBug storage directory.');
        }
    }

    public function write(string $path, string $contents): void
    {
        if (file_put_contents($path, $contents, LOCK_EX) === false) {
            throw new RuntimeException('Cannot write TraceBug report.');
        }
        @chmod($path, 0600);
    }
}
