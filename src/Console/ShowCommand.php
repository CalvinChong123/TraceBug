<?php

namespace TraceBug\Console;

use Illuminate\Console\Command;
use TraceBug\PrivateStore;

class ShowCommand extends Command
{
    protected $signature = 'tracebug:show {id} {--json}';
    protected $description = 'Inspect a private TraceBug report';

    public function handle(PrivateStore $store): int
    {
        $id = $this->argument('id');
        if (! preg_match('/^TB-[A-F0-9]{32}$/D', $id)) {
            $this->error('Invalid report ID.');
            return self::FAILURE;
        }
        $file = $store->root().'/reports/'.$id.'/'.($this->option('json') ? 'report.json' : 'report.log');
        if (! is_file($file)) {
            $this->error('Report not found.');
            return self::FAILURE;
        }
        $this->output->write(file_get_contents($file), false, \Symfony\Component\Console\Output\OutputInterface::OUTPUT_RAW);

        return self::SUCCESS;
    }
}
