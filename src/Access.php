<?php

namespace TraceBug;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;

class Access
{
    public function user(Request $request)
    {
        return $request->user(config('tracebug.guard'));
    }

    public function allows(Request $request): bool
    {
        if (! config('tracebug.enabled') || ! is_string(config('app.key')) || config('app.key') === '') return false;
        try {
            $user = $this->user($request);
            if (! $user) return false;
            $ids = array_map('strval', config('tracebug.allowed_users', []));
            if (in_array((string) $user->getAuthIdentifier(), $ids, true)) return true;
            $ability = config('tracebug.gate');
            return is_string($ability) && $ability !== '' && Gate::forUser($user)->allows($ability);
        } catch (\Throwable $ignored) {
            return false; // A broken host Gate must not break an ordinary page.
        }
    }

    public function scope(Request $request): string
    {
        $user = $this->user($request);
        $session = $request->hasSession() ? $request->session()->getId() : 'api';

        return hash_hmac('sha256', get_class($user).':'.$user->getAuthIdentifier().':'.$session, (string) config('app.key'));
    }
}
