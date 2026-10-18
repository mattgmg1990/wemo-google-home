<?php
require __DIR__ . '/lib.php';

function send_remote_json($payload, $statusCode) {
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=UTF-8');
    header('Cache-Control: no-store');
    echo json_encode($payload);
    exit;
}
function remote_header($name) {
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (isset($_SERVER[$key]) && is_string($_SERVER[$key])) return trim($_SERVER[$key]);
    if (function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        foreach ($headers as $key => $value) if (strcasecmp($key, $name) === 0 && is_string($value)) return trim($value);
    }
    return '';
}
function remote_value($name) { return isset($_POST[$name]) && is_string($_POST[$name]) ? trim($_POST[$name]) : ''; }

if ($_SERVER['REQUEST_METHOD'] !== 'POST') send_remote_json(array('ok' => false, 'error' => 'POST required.'), 405);
if (wemo_remote_config() === null) send_remote_json(array('ok' => false, 'error' => 'Remote control is not configured on this Pi.'), 503);
$token = remote_header('Authorization');
$token = preg_match('/^Bearer\s+(.+)$/iD', $token, $matches) ? trim($matches[1]) : '';
if ($token === '') $token = remote_header('X-Wemo-Token');
if ($token === '') $token = remote_value('token');
if (!wemo_remote_token_matches($token)) send_remote_json(array('ok' => false, 'error' => 'Unauthorized.'), 401);

$action = remote_value('action'); $id = remote_value('device_id'); $ip = remote_value('device_ip');
if ($action === 'health') {
    $snapshot = wemo_status_snapshot(); unset($snapshot['devices']);
    send_remote_json($snapshot, 200);
}
if ($action === 'status') {
    $snapshot = wemo_status_snapshot();
    if ($id !== '' || ($ip !== '' && $ip !== '__all__')) {
        $serial = wemo_resolve_serial($id, $ip, wemo_registry_load());
        if ($serial === null) send_remote_json(array('ok' => false, 'error' => 'Device not found.'), 404);
        foreach ($snapshot['devices'] as $device) if ($device['serial'] === $serial) $snapshot['device'] = $device;
        unset($snapshot['devices']);
    }
    send_remote_json($snapshot, 200);
}
if ($action !== 'on' && $action !== 'off') send_remote_json(array('ok' => false, 'error' => 'Unknown action.'), 400);
if ($id === '' && ($ip === '' || $ip === '__all__')) {
    $result = wemo_set_all_devices(wemo_get_devices(false), $action === 'on' ? 1 : 0);
    $ok = empty($result['failed_devices']);
    send_remote_json(array('ok' => $ok, 'devices' => $result['devices'], 'failed_devices' => $result['failed_devices']), $ok ? 200 : 502);
}
$serial = wemo_resolve_serial($id, $ip, wemo_registry_load());
if ($serial === null) send_remote_json(array('ok' => false, 'error' => 'Device not found.'), 404);
$result = wemo_command($serial, $action === 'on' ? 1 : 0);
$status = $result['code']; unset($result['code']);
send_remote_json($result, $status);
