<?php

namespace TraceBug;

use Illuminate\Http\Request;

class Access
{
    public function user(Request $request)
    {
        return $request->user(config('tracebug.guard'));
    }

    public function allows(Request $request): bool
    {
        if (! config('tracebug.enabled') || ! $user = $this->user($request)) {
            return false;
        }

        $ids = array_map('strval', config('tracebug.allowed_users', []));

        return $ids === [] || in_array((string) $user->getAuthIdentifier(), $ids, true);
    }

    public function scope(Request $request): string
    {
        $user = $this->user($request);
        $session = $request->hasSession() ? $request->session()->getId() : 'api';

        return hash_hmac('sha256', get_class($user).':'.$user->getAuthIdentifier().':'.$session, (string) config('app.key'));
    }
}
