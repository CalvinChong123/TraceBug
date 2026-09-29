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
        if ($path === '' || preg_match('~(?:^|/)\.{1,2}(?:/|$)~', str_replace('\\', '/', $path))
            || (! str_starts_with($path, '/') && ! preg_match('/^[A-Za-z]:[\\\\\/]/', $path) && ! str_starts_with($path, '\\\\'))) {
            throw new RuntimeException('TraceBug storage requires an absolute path without parent traversal.');
        }
        $public = realpath(public_path());
        $existing = $path;
        while (! file_exists($existing)) {
            $parent = dirname($existing);
            if ($parent === $existing) throw new RuntimeException('Invalid TraceBug storage path.');
            $existing = $parent;
        }
        $realExisting = realpath($existing);
        if ($realExisting === false) throw new RuntimeException('Cannot resolve TraceBug storage path.');
        $candidate = $realExisting.substr($path, strlen($existing));
        if ($public && $this->isWithin($candidate, $public)) {
            throw new RuntimeException('TraceBug storage must be outside the public directory.');
        }
        foreach ([base_path(), storage_path(), storage_path('logs'), storage_path('app'), storage_path('framework')] as $shared) {
            $realShared = realpath($shared);
            if ($realShared && $this->samePath($candidate, $realShared)) {
                throw new RuntimeException('TraceBug storage must use a dedicated directory.');
            }
        }
        $this->directory($path);
        $real = realpath($path);
        if ($real === false || ($public && $this->isWithin($real, $public)) || is_link($real.'/reports')) {
            throw new RuntimeException('TraceBug storage path is unsafe or public.');
        }

        return $real;
    }

    private function isWithin(string $path, string $root): bool
    {
        $path = strtolower(str_replace('\\', '/', $path));
        $root = rtrim(strtolower(str_replace('\\', '/', $root)), '/');
        return $path === $root || str_starts_with($path, $root.'/');
    }

    private function samePath(string $left, string $right): bool
    {
        return rtrim(strtolower(str_replace('\\', '/', $left)), '/') === rtrim(strtolower(str_replace('\\', '/', $right)), '/');
    }

    public function cache(): Repository
    {
        $path = $this->root().'/context';
        $this->directory($path);

        // FileStore also uses its file mode for nested directories. Keep the
        // context tree private and let those directories remain traversable.
        return new Repository(new FileStore(new Filesystem, $path));
    }

    public function directory(string $path): void
    {
        if (is_link($path)) {
            throw new RuntimeException('TraceBug storage path must not be a symlink.');
        }
        if (! is_dir($path)) {
            if (! @mkdir($path, 0700, true) && ! is_dir($path)) {
                throw new RuntimeException('Cannot create TraceBug storage directory.');
            }
            @chmod($path, 0700);
        }
        clearstatcache(true, $path);
        if (DIRECTORY_SEPARATOR === '/' && ((fileperms($path) & 0077) !== 0)) {
            throw new RuntimeException('TraceBug storage directory is not private.');
        }
    }

    public function write(string $path, string $contents): void
    {
        if (file_put_contents($path, $contents, LOCK_EX) === false) {
            throw new RuntimeException('Cannot write TraceBug report.');
        }
        $changed = @chmod($path, 0600);
        if (DIRECTORY_SEPARATOR === '/' && (! $changed || ((fileperms($path) & 0077) !== 0))) {
            throw new RuntimeException('TraceBug report file is not private.');
        }
    }
}
