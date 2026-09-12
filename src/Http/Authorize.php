<?php

namespace TraceBug\Http;

use Closure;
use Illuminate\Http\Request;
use TraceBug\Access;

class Authorize
{
    public function handle(Request $request, Closure $next)
    {
        abort_unless(app(Access::class)->allows($request), 404);

        return $next($request);
    }
}
