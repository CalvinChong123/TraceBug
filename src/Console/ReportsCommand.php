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
            $report = json_decode(file_get_contents($file), true);
            if ($report) {
                $rows[] = [$report['report_id'], $report['received_at'], $report['user_id'], $report['page']['url']];
            }
        }
        $this->table(['Report ID', 'Received', 'User', 'Page'], $rows);

        return self::SUCCESS;
    }
}
