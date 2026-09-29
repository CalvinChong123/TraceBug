<?php

namespace TraceBug\Console;

use Illuminate\Console\Command;
use TraceBug\PrivateStore;

class ReportsCommand extends Command
{
    protected $signature = 'tracebug:list';
    protected $description = 'List private TraceBug reports';

    public function handle(PrivateStore $store): int
    {
        $rows = [];
        foreach (glob($store->root().'/reports/TB-*/report.json') ?: [] as $file) {
            if (is_link(dirname($file)) || is_link($file)) continue;
            $report = json_decode(file_get_contents($file), true);
            if ($report) {
                $rows[] = [$report['report_id'], $report['received_at'], $report['user_ref'] ?? $report['user_id'] ?? 'unknown', $report['qa']['summary'], $report['page']['url']];
            }
        }
        usort($rows, fn ($a, $b) => strcmp($b[1], $a[1]));
        $this->table(['Report ID', 'Received', 'User ref', 'Summary', 'Page'], $rows);

        return self::SUCCESS;
    }
}
