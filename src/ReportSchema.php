<?php

namespace TraceBug;

use Illuminate\Validation\ValidationException;

/** The wire format is deliberately closed: browser input is never trusted. */
class ReportSchema
{
    public function validate(array $payload): array
    {
        $unknown = array_diff(array_keys($payload), ['schema_version', 'submission_id', 'captured_at', 'page', 'qa', 'events', 'ui', 'screenshot_status', 'screenshot_source']);
        if ($unknown) throw ValidationException::withMessages(['payload' => 'Unknown report fields.']);
        $rules = [
            'schema_version' => ['required', 'integer', 'in:1'],
            'submission_id' => ['required', 'uuid'],
            'captured_at' => ['required', 'date'],
            'page' => ['required', 'array:url,viewport,screen,dpr,orientation,user_agent'],
            'page.url' => ['required', 'string', 'max:2048'],
            'page.viewport' => ['sometimes', 'array:width,height'],
            'page.screen' => ['sometimes', 'array:width,height'],
            'page.dpr' => ['sometimes', 'numeric', 'between:0,16'],
            'page.orientation' => ['sometimes', 'in:portrait,landscape,portrait-primary,portrait-secondary,landscape-primary,landscape-secondary'],
            'page.user_agent' => ['sometimes', 'regex:/^(Chrome|Firefox|Safari|Edge|Other)(\/[0-9]{1,3})?$/'],
            'qa' => ['required', 'array:summary,steps,expected,actual'],
            'qa.summary' => ['required', 'string', 'min:3', 'max:500'],
            'qa.steps' => [config('tracebug.require_steps') ? 'required' : 'sometimes', 'string', 'max:1000'],
            'qa.expected' => ['sometimes', 'string', 'max:1000'],
            'qa.actual' => ['sometimes', 'string', 'max:1000'],
            'events' => ['present', 'array', 'max:50'],
            'events.*' => ['array:id,at,type,data'],
            'events.*.id' => ['required', 'string', 'max:64'],
            'events.*.at' => ['required', 'numeric'],
            'events.*.type' => ['required', 'in:network,error,vue,console,navigation,click,submit'],
            'events.*.data' => ['required', 'array'],
            'ui' => ['present', 'array:viewport_width,document_width,horizontal_overflow,overflow_candidates,broken_images,scanned_elements,scan_truncated'],
            'ui.viewport_width' => ['sometimes', 'numeric', 'between:0,100000'],
            'ui.document_width' => ['sometimes', 'numeric', 'between:0,100000'],
            'ui.horizontal_overflow' => ['sometimes', 'boolean'],
            'ui.scanned_elements' => ['sometimes', 'integer', 'between:0,2000'],
            'ui.scan_truncated' => ['sometimes', 'boolean'],
            'ui.overflow_candidates' => ['sometimes', 'array', 'max:20'],
            'ui.broken_images' => ['sometimes', 'array', 'max:30'],
            'ui.overflow_candidates.*' => ['array:label,x,y,width,height'],
            'ui.broken_images.*' => ['array:src,width,height,natural_width,natural_height'],
            'ui.overflow_candidates.*.label' => ['sometimes', 'regex:/^[a-z][a-z0-9-]{0,30}$/'],
            'ui.broken_images.*.src' => ['sometimes', 'string', 'max:2048'],
            'screenshot_status' => ['required', 'in:captured,disabled'],
            'screenshot_source' => ['required', 'in:browser,upload,paste,none'],
        ];
        foreach (['page.viewport', 'page.screen'] as $group) {
            foreach (['width', 'height'] as $axis) $rules[$group.'.'.$axis] = ['sometimes', 'numeric', 'between:0,100000'];
        }
        foreach (['ui.overflow_candidates', 'ui.broken_images'] as $group) {
            foreach (['x', 'y', 'width', 'height', 'natural_width', 'natural_height'] as $axis) {
                $rules[$group.'.*.'.$axis] = ['sometimes', 'numeric', 'between:-100000,100000'];
            }
        }
        foreach (['events', 'ui.overflow_candidates', 'ui.broken_images'] as $path) {
            $value = data_get($payload, $path);
            if (is_array($value) && array_keys($value) !== ($value ? range(0, count($value) - 1) : [])) {
                throw ValidationException::withMessages([$path => 'Expected a list.']);
            }
        }
        $base = validator($payload, $rules)->validate();
        if (trim($base['qa']['summary']) === '' || (config('tracebug.require_steps') && trim($base['qa']['steps']) === '')) {
            throw ValidationException::withMessages(['qa' => 'Summary and reproduction steps must contain text.']);
        }
        foreach ($base['events'] as $index => $event) {
            $allowed = match ($event['type']) {
                'network' => 'method,url,state,status,duration_ms,request_id,client_id,initiator_type,transfer_size,slow',
                'error', 'vue' => 'name,frames,source_url,line,column',
                'console' => 'name',
                'navigation' => 'url',
                'click', 'submit' => 'label,bounds',
            };
            $prefix = 'events.'.$index.'.data';
            $eventRules = [$prefix => ['array:'.$allowed]];
            if ($event['type'] === 'network') {
                $eventRules += [
                    $prefix.'.method' => ['sometimes', 'in:GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS,OTHER'],
                    $prefix.'.url' => ['sometimes', 'string', 'max:2048'],
                    $prefix.'.state' => ['sometimes', 'in:pending,completed,failed,timeout,cancelled'],
                    $prefix.'.status' => ['nullable', 'integer', 'between:0,599'],
                    $prefix.'.duration_ms' => ['sometimes', 'numeric', 'between:0,3600000'],
                    $prefix.'.request_id' => ['nullable', 'uuid'],
                    $prefix.'.client_id' => ['sometimes', 'uuid'],
                    $prefix.'.initiator_type' => ['sometimes', 'in:img,script,link,css,iframe,other'],
                    $prefix.'.transfer_size' => ['sometimes', 'numeric', 'between:0,1000000000'],
                    $prefix.'.slow' => ['sometimes', 'boolean'],
                ];
            } elseif (in_array($event['type'], ['error', 'vue'], true)) {
                $frames = $event['data']['frames'] ?? [];
                if (is_array($frames) && array_keys($frames) !== ($frames ? range(0, count($frames) - 1) : [])) {
                    throw ValidationException::withMessages([$prefix.'.frames' => 'Expected a list.']);
                }
                $eventRules += [
                    $prefix.'.name' => ['sometimes', 'in:Error,TypeError,ReferenceError,SyntaxError,RangeError,URIError,EvalError,UnknownError,ImageLoadError,OtherError'],
                    $prefix.'.frames' => ['sometimes', 'array', 'max:8'],
                    $prefix.'.frames.*' => ['array:url,line,column'],
                    $prefix.'.frames.*.url' => ['sometimes', 'string', 'max:2048'],
                    $prefix.'.frames.*.line' => ['sometimes', 'integer', 'between:0,10000000'],
                    $prefix.'.frames.*.column' => ['sometimes', 'integer', 'between:0,10000000'],
                    $prefix.'.source_url' => ['sometimes', 'string', 'max:2048'],
                    $prefix.'.line' => ['sometimes', 'integer', 'between:0,10000000'],
                    $prefix.'.column' => ['sometimes', 'integer', 'between:0,10000000'],
                ];
            } elseif ($event['type'] === 'console') {
                $eventRules[$prefix.'.name'] = ['sometimes', 'in:ConsoleError'];
            } elseif ($event['type'] === 'navigation') {
                $eventRules[$prefix.'.url'] = ['sometimes', 'string', 'max:2048'];
            } else {
                $eventRules += [
                    $prefix.'.label' => ['sometimes', 'regex:/^[a-z][a-z0-9-]{0,30}$/'],
                    $prefix.'.bounds' => ['sometimes', 'array:x,y,width,height'],
                ];
                foreach (['x', 'y', 'width', 'height'] as $axis) $eventRules[$prefix.'.bounds.'.$axis] = ['sometimes', 'numeric', 'between:-100000,100000'];
            }
            validator($payload, $eventRules)->validate();
        }

        return $base;
    }
}
