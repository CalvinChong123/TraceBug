<?php

namespace TraceBug;

use Illuminate\Http\UploadedFile;
use Illuminate\Validation\ValidationException;

class ScreenshotSanitizer
{
    public function sanitize(UploadedFile $file): string
    {
        if (! function_exists('imagecreatefromstring') || ! function_exists('imagewebp')) {
            throw ValidationException::withMessages(['screenshot' => 'Screenshot processing is unavailable on this server.']);
        }
        $path = $file->getRealPath();
        $size = @getimagesize($path);
        if (! $size || ! in_array($size['mime'], ['image/png', 'image/jpeg', 'image/webp'], true)
            || $size[0] < 1 || $size[1] < 1 || $size[0] > 4000 || $size[1] > 4000
            || $size[0] * $size[1] > 4000000) {
            throw ValidationException::withMessages(['screenshot' => 'Screenshot dimensions or format are not allowed.']);
        }
        $limit = $this->memoryLimit();
        if ($limit !== null && memory_get_usage(true) + $size[0] * $size[1] * 16 + 20 * 1024 * 1024 > $limit) {
            throw ValidationException::withMessages(['screenshot' => 'Insufficient memory to process screenshot safely.']);
        }
        $source = @imagecreatefromstring(file_get_contents($path));
        if ($source === false) throw ValidationException::withMessages(['screenshot' => 'Invalid screenshot image.']);
        try {
            ob_start();
            try {
                $ok = imagewebp($source, null, 80);
                $bytes = ob_get_clean();
            } catch (\Throwable $error) {
                ob_end_clean();
                throw ValidationException::withMessages(['screenshot' => 'Cannot process screenshot image.']);
            }
            if (! $ok || ! is_string($bytes) || $bytes === '' || strlen($bytes) > 2 * 1024 * 1024
                || (@getimagesizefromstring($bytes)['mime'] ?? null) !== 'image/webp') {
                throw ValidationException::withMessages(['screenshot' => 'Processed screenshot exceeds 2 MB.']);
            }
            return $bytes;
        } finally {
            imagedestroy($source);
        }
    }

    private function memoryLimit(): ?int
    {
        $value = trim(ini_get('memory_limit'));
        if ($value === '-1' || $value === '') return null;
        $unit = strtolower(substr($value, -1));
        $number = (int) $value;
        return $number * match ($unit) { 'g' => 1073741824, 'm' => 1048576, 'k' => 1024, default => 1 };
    }
}
