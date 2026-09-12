<?php

namespace TraceBug;

class Redactor
{
    public function text(string $value): string
    {
        $value = preg_replace('/[\x00-\x1F\x7F]/', ' ', $value);
        $value = preg_replace('/Bearer\s+\S+/i', '[redacted]', $value);
        $value = preg_replace('/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i', '[email]', $value);
        $value = preg_replace('/\b(password|token|secret|authorization|cookie|api[_-]?key|csrf)\s*[:=]\s*[^\s,;]+/i', '$1=[redacted]', $value);
        $value = preg_replace('/\b\d{12,19}\b/', '[number]', $value);
        foreach (config('tracebug.redact_patterns', []) as $pattern) {
            $value = preg_replace($pattern, '[redacted]', $value) ?? '[redacted]';
        }

        return mb_substr($value, 0, 1000);
    }

    public function url(string $value): string
    {
        $path = parse_url($value, PHP_URL_PATH);
        if (! is_string($path)) {
            return '[invalid-url]';
        }
        $path = preg_replace('~/[0-9]+(?=/|$)~', '/:id', $path);
        $path = preg_replace('~/[a-zA-Z0-9_-]{24,}(?=/|$)~', '/:id', $path);

        return $this->text($path);
    }

    public function clean($value, int $depth = 0)
    {
        if ($depth > 8) {
            return '[truncated]';
        }
        if (is_array($value)) {
            $result = [];
            foreach (array_slice($value, 0, 100, true) as $key => $item) {
                if (is_string($key) && preg_match('/password|cookie|authorization|token|secret|body|headers|bindings|field.?values/i', $key)) {
                    continue;
                }
                if (in_array($key, ['id', 'request_id', 'client_id', 'submission_id'], true) && is_string($item) && \Illuminate\Support\Str::isUuid($item)) {
                    $result[$key] = $item;
                    continue;
                }
                $result[$key] = is_string($key) && preg_match('/url|src/i', $key) && is_string($item)
                    ? $this->url($item) : $this->clean($item, $depth + 1);
            }

            return $result;
        }

        return is_string($value) ? $this->text($value) : (is_scalar($value) || $value === null ? $value : '[omitted]');
    }
}
