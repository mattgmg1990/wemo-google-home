<?php
// All device traffic is mocked before loading the production library.
$testDir = sys_get_temp_dir() . '/wemo-regression-' . getmypid() . '-' . uniqid();
mkdir($testDir, 0700);
define('WEMO_STATE_DIR', $testDir);
define('WEMO_LEGACY_CACHE_FILE', $testDir . '/legacy.json');
define('WEMO_REMOTE_CONFIG_FILE', $testDir . '/config.php');
define('WEMO_WORKER_LIBRARY_ONLY', true);
$GLOBALS['calls'] = array();
$GLOBALS['mock'] = null;
function wemo_http($url, $method, $headers, $body, $deadline) {
    $GLOBALS['calls'][] = array($url, $method, $body, $deadline);
    if ($GLOBALS['mock'] === null) throw new Exception('Unexpected network request');
    return call_user_func($GLOBALS['mock'], $url, $method, $headers, $body, $deadline);
}
require __DIR__ . '/../lib.php';
require __DIR__ . '/../worker.php';
$passed = 0;
function check($condition, $description) {
    if (!$condition) throw new Exception($description);
    $GLOBALS['passed']++;
}
function descriptor_xml($serial, $state = '1', $control = '/upnp/control/basicevent1') {
    return '<?xml version="1.0"?><root xmlns="urn:Belkin:device-1-0"><device>'
        . '<friendlyName>Untrusted generic name</friendlyName><serialNumber>' . $serial . '</serialNumber>'
        . '<binaryState>' . $state . '</binaryState><serviceList><service>'
        . '<serviceType>urn:Belkin:service:basicevent:1</serviceType><controlURL>' . $control . '</controlURL>'
        . '</service></serviceList></device></root>';
}
function soap_xml($action, $state) {
    return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>'
        . '<u:' . $action . 'Response xmlns:u="urn:Belkin:service:basicevent:1"><BinaryState>' . $state
        . '</BinaryState></u:' . $action . 'Response></s:Body></s:Envelope>';
}
function seeded($serial, $ip, $state, $seen) {
    $device = wemo_parse_descriptor(descriptor_xml($serial), 'http://' . $ip . ':49153/setup.xml');
    wemo_registry_update(function ($registry) use ($serial, $device, $state, $seen) {
        $registry['devices'][$serial] = array_merge($registry['devices'][$serial], $device,
            array('state' => $state, 'online' => true, 'observedAt' => $seen, 'checkedAt' => $seen));
        unset($registry['devices'][$serial]['error']);
        $registry['workerObservedAt'] = wemo_now_ms();
        return $registry;
    });
}
function clear_test_files() {
    foreach (glob(WEMO_STATE_DIR . '/*') as $file) if (is_file($file)) unlink($file);
    foreach (glob(WEMO_STATE_DIR . '/.registry-*') as $file) if (is_file($file)) unlink($file);
    rmdir(WEMO_STATE_DIR);
}
$chair = '221633K0101A1F'; $couch = '221734K0103D82'; $red = '221741K01064DC';
try {
    $initial = wemo_status_snapshot();
    check(count($initial['devices']) === 3 && $initial['health']['offline'] === 3, 'Missing registry must retain all three known identities');
    check(!$initial['health']['healthy'] && !$initial['health']['registryHealthy'], 'Missing registry must be unhealthy');
    check(count($GLOBALS['calls']) === 0, 'Cold status must not perform discovery or network I/O');

    file_put_contents(WEMO_LEGACY_CACHE_FILE, json_encode(array('devices' => array(array('serial' => $chair,
        'location' => 'http://192.168.68.50:49153/setup.xml', 'state' => '1')))));
    check(wemo_worker_bootstrap(), 'Legacy bootstrap writes durable registry');
    $initial = wemo_status_snapshot();
    check($initial['health']['offline'] === 3 && $initial['devices'][2]['observedAt'] === null, 'Legacy XML state must never establish live state');
    check(wemo_registry_load()['devices'][$chair]['ip'] === '192.168.68.50', 'Legacy address hints bootstrap permanent identity');

    seeded($chair, '192.168.68.50', 0, wemo_now_ms());
    seeded($couch, '192.168.68.64', 1, wemo_now_ms());
    seeded($red, '192.168.68.65', 0, wemo_now_ms());
    $live = wemo_status_snapshot();
    check($live['health']['healthy'] && $live['health']['online'] === 3, 'Fresh observations and worker report healthy');
    check($live['devices'][0]['observedAt'] > 1000000000000.0, 'Millisecond timestamps survive 32-bit PHP');
    check((fileperms(WEMO_STATE_DIR . '/registry.json') & 0777) === 0600, 'Persistent registry has private permissions');
    $saved = file_get_contents(WEMO_STATE_DIR . '/registry.json');
    check(json_decode($saved, true)['devices'][$chair]['serial'] === $chair, 'Registry identity survives a fresh disk read');

    wemo_record_result($chair, null, null, 'deviceUnreachable', wemo_now_ms());
    $failed = wemo_public_device(wemo_registry_load()['devices'][$chair]);
    check(!$failed['online'] && $failed['state_value'] === 0 && $failed['observedAt'] !== null, 'Failed probe retains last state and identity while marking offline');
    check(wemo_status_snapshot()['health']['online'] === 2, 'A failed light does not mark its siblings offline');
    seeded($chair, '192.168.68.50', 0, wemo_now_ms() - 31000);
    check(!wemo_public_device(wemo_registry_load()['devices'][$chair])['online'], 'Stale success is not reported online');
    check(wemo_get_state(wemo_registry_load()['devices'][$chair]) === null, 'Legacy state accessor cannot fabricate stale live state');
    seeded($chair, '192.168.68.50', 0, wemo_now_ms());

    $moved = wemo_parse_descriptor(descriptor_xml($chair), 'http://192.168.68.51:49153/setup.xml');
    wemo_merge_discovery(array($chair => $moved));
    check(wemo_registry_load()['devices'][$chair]['ip'] === '192.168.68.51', 'Discovery follows a serial to its new address');
    check(!wemo_public_device(wemo_registry_load()['devices'][$chair])['online'], 'New descriptor alone cannot claim current on/off state');
    wemo_merge_discovery(array());
    check(count(wemo_registry_load()['devices']) === 3, 'A missed SSDP reply must never delete an identity');

    $GLOBALS['mock'] = function ($url, $method, $headers, $body, $deadline) use ($chair) {
        if ($method === 'GET') return descriptor_xml($chair);
        return soap_xml('SetBinaryState', 1);
    };
    $GLOBALS['calls'] = array();
    $result = wemo_command($chair, 1);
    check($result['ok'] && $result['device']['online'] && $result['device']['state_value'] === 1, 'Serial-target command verifies and confirms state');
    check(count($GLOBALS['calls']) === 2 && strpos($GLOBALS['calls'][0][0], '192.168.68.51') !== false, 'Warm command uses current address with only identity GET and confirmed SET');
    check(wemo_resolve_serial('', '192.168.68.51', wemo_registry_load()) === $chair, 'Legacy IP targeting resolves the same permanent identity');
    check(wemo_resolve_serial($chair, '192.168.68.64', wemo_registry_load()) === $chair, 'Serial has precedence over legacy IP');

    $GLOBALS['mock'] = function ($url, $method, $headers, $body, $deadline) use ($couch) {
        if ($method === 'GET') return descriptor_xml($couch);
        throw new Exception('Must never command a reassigned address');
    };
    $GLOBALS['calls'] = array();
    $result = wemo_command($chair, 0);
    check(!$result['ok'] && $result['error'] === 'identityMismatch' && count($GLOBALS['calls']) === 1, 'IP reassignment cannot control another plug');

    $GLOBALS['mock'] = function ($url, $method, $headers, $body, $deadline) use ($chair) {
        return $method === 'GET' ? descriptor_xml($chair) : '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>failure</s:Fault></s:Body></s:Envelope>';
    };
    $GLOBALS['calls'] = array(); $result = wemo_command($chair, 0);
    check(!$result['ok'] && !$result['device']['online'], 'SOAP Fault never becomes a false command success');
    $sets = 0;
    foreach ($GLOBALS['calls'] as $call) if (strpos($call[2], '<u:SetBinaryState ') !== false) $sets++;
    check($sets === 2, 'Idempotent set retries are bounded to two');

    $GLOBALS['setAttempts'] = 0;
    $GLOBALS['mock'] = function ($url, $method, $headers, $body, $deadline) use ($chair) {
        if ($method === 'GET') return descriptor_xml($chair);
        if (strpos($body, '<u:SetBinaryState ') !== false) { $GLOBALS['setAttempts']++; return null; }
        return soap_xml('GetBinaryState', 0);
    };
    $result = wemo_command($chair, 0);
    check($result['ok'] && $GLOBALS['setAttempts'] === 1, 'Lost set reply can be confirmed by actual GetBinaryState without duplicate set');
    check(wemo_parse_binary(soap_xml('GetBinaryState', 'unknown'), 'GetBinaryState') === null, 'Malformed binary value is rejected');
    check(wemo_parse_binary(soap_xml('GetBinaryState', '1|0|123'), 'GetBinaryState') === 1, 'Legacy extended binary format accepted');
    check(wemo_parse_binary('<html>200 OK</html>', 'SetBinaryState') === null, 'HTTP success alone is not SOAP confirmation');

    $oldStarted = wemo_now_ms() - 5000;
    wemo_record_result($chair, null, null, 'deviceUnreachable', $oldStarted);
    check(wemo_public_device(wemo_registry_load()['devices'][$chair])['online'], 'Late failure cannot overwrite a newer command success');
    $olderEndpoint = $moved; $olderEndpoint['ip'] = '192.168.68.99'; $olderEndpoint['endpointAt'] = wemo_now_ms() - 10000;
    wemo_merge_discovery(array($chair => $olderEndpoint));
    check(wemo_registry_load()['devices'][$chair]['ip'] === '192.168.68.51', 'Older discovery cannot overwrite a newer verified endpoint');
    wemo_merge_discovery(array(), array($chair => true));
    $GLOBALS['calls'] = array();
    $result = wemo_command($chair, 0);
    check(!$result['ok'] && $result['error'] === 'identityAmbiguous' && count($GLOBALS['calls']) === 0, 'Duplicate serial blocks commands before any device traffic');
    wemo_worker_poll($chair);
    check(count($GLOBALS['calls']) === 0 && !wemo_public_device(wemo_registry_load()['devices'][$chair])['online'], 'Polling cannot clear duplicate serial ambiguity');
    wemo_merge_discovery(array());
    check(wemo_registry_load()['devices'][$chair]['identityAmbiguous'], 'An empty discovery cannot clear known identity ambiguity');
    $moved['endpointAt'] = wemo_now_ms();
    wemo_merge_discovery(array($chair => $moved));
    check(!wemo_registry_load()['devices'][$chair]['identityAmbiguous'], 'A later unambiguous discovery permits recovery');
    $result = wemo_command($chair, 0);
    check($result['ok'], 'Recovered unique identity can be commanded again');
    wemo_registry_update(function ($registry) use ($chair, $couch) { $registry['devices'][$couch]['ip'] = $registry['devices'][$chair]['ip']; return $registry; });
    check(count(wemo_get_devices(false)) === 3, 'Legacy inventory never drops identities when remembered IPs collide');
    check(wemo_resolve_serial('', '192.168.68.51', wemo_registry_load()) === null, 'Ambiguous legacy IP targeting fails closed');
    seeded($couch, '192.168.68.64', 1, wemo_now_ms());
    $lock = wemo_lock('device-' . $chair, microtime(true));
    $GLOBALS['calls'] = array();
    check(wemo_worker_poll($chair) && count($GLOBALS['calls']) === 0, 'Worker immediately yields to an in-progress command');
    $before = microtime(true); $result = wemo_command($chair, 0, microtime(true) + 0.04);
    check(!$result['ok'] && $result['error'] === 'Device is busy.' && microtime(true) - $before < 0.2, 'Command lock wait honors its total deadline');
    wemo_unlock($lock);

    $GLOBALS['mock'] = null; $GLOBALS['calls'] = array();
    wemo_status_snapshot(); wemo_get_devices(true); wemo_get_state(wemo_registry_load()['devices'][$chair]);
    check(count($GLOBALS['calls']) === 0, 'Status and forced legacy refresh are disk-only');
    check(wemo_parse_descriptor(descriptor_xml('UNKNOWN'), 'http://192.168.68.50:49153/setup.xml') === null, 'Unknown serial cannot join the control registry');
    check(wemo_parse_descriptor(descriptor_xml($chair), 'http://example.com/setup.xml') === null, 'Discovery cannot direct requests to external hosts');
    check(wemo_parse_descriptor(descriptor_xml($chair, '1', '//example.com/control'), 'http://192.168.68.50:49153/setup.xml') === null, 'Control endpoint must remain on the verified plug');
    check(wemo_parse_descriptor('<!DOCTYPE root [<!ENTITY x SYSTEM "file:///etc/passwd">]>' . descriptor_xml($chair), 'http://192.168.68.50/setup.xml') === null, 'Descriptor entity expansion is rejected');

    file_put_contents(WEMO_REMOTE_CONFIG_FILE, '<?php return array("token" => "fixture-random-token");');
    check(wemo_remote_token_matches('fixture-random-token') && !wemo_remote_token_matches('fixture-random-tokeN'), 'Authentication remains exact with constant-work PHP5.4 comparison');
    check(!wemo_remote_token_matches('') && !wemo_remote_token_matches(array('fixture-random-token')), 'Invalid credential types are rejected');
    wemo_registry_update(function ($registry) { $registry['workerObservedAt'] = wemo_now_ms() - 46000; return $registry; });
    check(!wemo_status_snapshot()['health']['workerHealthy'], 'A stopped worker becomes unhealthy after45seconds');
    file_put_contents(WEMO_STATE_DIR . '/registry.json', '{partial');
    check(!wemo_status_snapshot()['health']['registryHealthy'] && count(wemo_status_snapshot()['devices']) === 3, 'Corrupt registry fails closed while retaining known identities');
    clear_test_files();
    echo json_encode(array('ok' => true, 'assertions' => $passed, 'php' => PHP_VERSION, 'integerBytes' => PHP_INT_SIZE, 'network' => 'mocked')) . "\n";
} catch (Exception $error) {
    clear_test_files(); fwrite(STDERR, $error->getMessage() . "\n"); exit(1);
}
