<?php
// Optional live transport fixture: local test HTTP server, never actual plugs.
require __DIR__ . '/../lib.php';
if ($argc !== 2) { fwrite(STDERR, "Usage: php tests/transport.php http://192.168.68.69:fixture-port\n"); exit(1); }
$base = $argv[1]; $results = array();
foreach (array('length' => 'hello', 'chunked' => 'hello', 'eof' => 'hello',
    'error' => null, 'redirect' => null, 'slow-header' => null, 'slow-body' => null) as $path => $expected) {
    $started = microtime(true);
    $actual = wemo_http($base . '/' . $path, 'GET', array(), '', $started + 0.25);
    $elapsed = microtime(true) - $started;
    if ($actual !== $expected || $elapsed > 0.4) {
        fwrite(STDERR, 'Transport fixture failed: ' . $path . ' in ' . $elapsed . " seconds\n"); exit(1);
    }
    $results[$path] = round($elapsed * 1000);
}
echo json_encode(array('ok' => true, 'transportFixtureMs' => $results)) . "\n";
