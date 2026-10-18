<?php
// PHP 5.4 / 32-bit ARM compatible. Network discovery runs only in worker.php.
if (!defined('WEMO_STATE_DIR')) define('WEMO_STATE_DIR', '/var/lib/wemo');
if (!defined('WEMO_REMOTE_CONFIG_FILE')) define('WEMO_REMOTE_CONFIG_FILE', '/etc/wemo-remote.php');
if (!defined('WEMO_LEGACY_CACHE_FILE')) define('WEMO_LEGACY_CACHE_FILE', '/tmp/wemo-devices.json');
define('WEMO_STATE_MAX_AGE_MS', 30000);
define('WEMO_WORKER_MAX_AGE_MS', 45000);
define('WEMO_COMMAND_SECONDS', 3.5);

function h($value) { return htmlspecialchars($value, ENT_QUOTES, 'UTF-8'); }
function wemo_now_ms() { return floor(microtime(true) * 1000.0); }
function wemo_known_names() {
    return array('221734K0103D82' => 'Light Behind the Couch',
        '221741K01064DC' => 'Small Red Light', '221633K0101A1F' => 'Light Behind the Chair');
}
function wemo_empty_registry() {
    $devices = array();
    foreach (wemo_known_names() as $serial => $name) {
        $devices[$serial] = array('serial' => $serial, 'name' => $name, 'ip' => null,
            'location' => null, 'base_url' => null, 'control_url' => null,
            'state' => null, 'online' => false, 'observedAt' => null,
            'checkedAt' => null, 'endpointAt' => null, 'identityAmbiguous' => false, 'error' => 'notDiscovered');
    }
    return array('version' => 1, 'devices' => $devices, 'workerObservedAt' => null,
        'discoveryObservedAt' => null, 'updatedAt' => null);
}
function wemo_registry_load() {
    $raw = @file_get_contents(WEMO_STATE_DIR . '/registry.json');
    $data = $raw === false ? null : json_decode($raw, true);
    $seed = wemo_empty_registry();
    if (!is_array($data) || !isset($data['version'], $data['devices'])
        || $data['version'] !== 1 || !is_array($data['devices'])) {
        $seed['registryHealthy'] = false;
        return $seed;
    }
    foreach ($seed['devices'] as $serial => $device) {
        if (isset($data['devices'][$serial]) && is_array($data['devices'][$serial])) {
            $seed['devices'][$serial] = array_merge($device, $data['devices'][$serial]);
            $seed['devices'][$serial]['serial'] = $serial;
            $seed['devices'][$serial]['name'] = $device['name'];
        }
    }
    foreach (array('workerObservedAt', 'discoveryObservedAt', 'updatedAt') as $field) {
        if (isset($data[$field]) && is_numeric($data[$field])) $seed[$field] = (float)$data[$field];
    }
    $seed['registryHealthy'] = true;
    return $seed;
}
function wemo_lock($name, $deadline) {
    $handle = @fopen(WEMO_STATE_DIR . '/' . $name . '.lock', 'c');
    if ($handle === false) return false;
    @chmod(WEMO_STATE_DIR . '/' . $name . '.lock', 0600);
    do {
        if (@flock($handle, LOCK_EX | LOCK_NB)) return $handle;
        if (microtime(true) >= $deadline) break;
        usleep(10000);
    } while (true);
    fclose($handle);
    return false;
}
function wemo_unlock($handle) { @flock($handle, LOCK_UN); fclose($handle); }
function wemo_registry_update($update, $deadline = null) {
    if ($deadline === null) $deadline = microtime(true) + 0.2;
    $lock = wemo_lock('registry', $deadline);
    if ($lock === false) return false;
    $registry = wemo_registry_load();
    $registry = call_user_func($update, $registry);
    unset($registry['registryHealthy']);
    $registry['updatedAt'] = wemo_now_ms();
    $encoded = json_encode($registry);
    $temporary = $encoded === false ? false : @tempnam(WEMO_STATE_DIR, '.registry-');
    $success = false;
    if ($temporary !== false) {
        @chmod($temporary, 0600);
        $handle = @fopen($temporary, 'wb');
        if ($handle !== false) {
            $offset = 0;
            while ($offset < strlen($encoded)) {
                $written = @fwrite($handle, substr($encoded, $offset));
                if ($written === false || $written === 0) break;
                $offset += $written;
            }
            @fflush($handle);
            fclose($handle);
            if ($offset === strlen($encoded)) $success = @rename($temporary, WEMO_STATE_DIR . '/registry.json');
        }
        if (!$success) @unlink($temporary);
    }
    wemo_unlock($lock);
    return $success;
}
function wemo_is_lan_ip($ip) {
    // This bridge is for the existing home LAN; never follow discovery off-LAN.
    return is_string($ip) && preg_match('/^192\.168\.68\.(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/D', $ip);
}
function wemo_url_parts($url) {
    if (!is_string($url)) return null;
    $parts = @parse_url($url);
    if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])
        || $parts['scheme'] !== 'http' || !wemo_is_lan_ip($parts['host'])
        || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])
        || isset($parts['query'])) return null;
    $parts['port'] = isset($parts['port']) ? (int)$parts['port'] : 80;
    if ($parts['port'] < 1 || $parts['port'] > 65535) return null;
    $parts['path'] = isset($parts['path']) ? $parts['path'] : '/';
    if (preg_match('/[\r\n\x00]/', $parts['path'])) return null;
    return $parts;
}
function wemo_wait_stream($socket, $write, $deadline) {
    $remaining = $deadline - microtime(true);
    if ($remaining <= 0) return false;
    $seconds = (int)floor($remaining);
    $micros = (int)floor(($remaining - $seconds) * 1000000);
    $readers = $write ? null : array($socket);
    $writers = $write ? array($socket) : null;
    $except = null;
    return @stream_select($readers, $writers, $except, $seconds, $micros) > 0;
}
function wemo_decode_chunked($body) {
    $decoded = '';
    while (($end = strpos($body, "\r\n")) !== false) {
        $size = trim(substr($body, 0, $end));
        if (!preg_match('/^[0-9a-f]+(?:;[^\r\n]*)?$/iD', $size)) return null;
        $size = hexdec($size);
        $body = substr($body, $end + 2);
        if ($size === 0) return $decoded;
        if ($size > 131072 || strlen($body) < $size + 2) return null;
        $decoded .= substr($body, 0, $size);
        if (substr($body, $size, 2) !== "\r\n") return null;
        $body = substr($body, $size + 2);
    }
    return null;
}
if (!function_exists('wemo_http')) {
function wemo_http($url, $method, $headers, $body, $deadline) {
    $parts = wemo_url_parts($url);
    if ($parts === null || microtime(true) >= $deadline) return null;
    $errno = 0; $error = '';
    $socket = @stream_socket_client('tcp://' . $parts['host'] . ':' . $parts['port'],
        $errno, $error, max(0.001, $deadline - microtime(true)), STREAM_CLIENT_CONNECT);
    if ($socket === false) return null;
    stream_set_blocking($socket, 0);
    $request = $method . ' ' . $parts['path'] . " HTTP/1.0\r\nHost: " . $parts['host'] . ':' . $parts['port']
        . "\r\nConnection: close\r\n";
    foreach ($headers as $name => $value) $request .= $name . ': ' . $value . "\r\n";
    if ($method === 'POST') $request .= 'Content-Length: ' . strlen($body) . "\r\n";
    $request .= "\r\n" . $body;
    $offset = 0;
    while ($offset < strlen($request) && wemo_wait_stream($socket, true, $deadline)) {
        $written = @fwrite($socket, substr($request, $offset));
        if ($written === false || $written === 0) break;
        $offset += $written;
    }
    $response = ''; $complete = false;
    if ($offset === strlen($request)) {
        while (strlen($response) <= 131072 && wemo_wait_stream($socket, false, $deadline)) {
            $part = @fread($socket, 8192);
            if ($part === false) break;
            $response .= $part;
            if (feof($socket)) { $complete = true; break; }
            $headerEnd = strpos($response, "\r\n\r\n");
            if ($headerEnd !== false && preg_match('/\r\nContent-Length:\s*([0-9]+)/i', substr($response, 0, $headerEnd), $match)
                && strlen($response) - $headerEnd - 4 >= (int)$match[1]) { $complete = true; break; }
        }
    }
    fclose($socket);
    $headerEnd = strpos($response, "\r\n\r\n");
    if (!$complete || strlen($response) > 131072 || $headerEnd === false
        || !preg_match('/^HTTP\/1\.[01] 200(?: |\r)/', $response)) return null;
    $header = substr($response, 0, $headerEnd);
    $result = substr($response, $headerEnd + 4);
    if (preg_match('/\r\nTransfer-Encoding:\s*chunked/i', $header)) return wemo_decode_chunked($result);
    if (preg_match('/\r\nContent-Length:\s*([0-9]+)/i', $header, $match)) return substr($result, 0, (int)$match[1]);
    return $result;
}
}
function wemo_parse_descriptor($xmlText, $location) {
    $parts = wemo_url_parts($location);
    if ($parts === null || !is_string($xmlText) || stripos($xmlText, '<!DOCTYPE') !== false) return null;
    $previous = libxml_disable_entity_loader(true);
    $xml = @simplexml_load_string($xmlText, 'SimpleXMLElement', LIBXML_NONET);
    libxml_disable_entity_loader($previous);
    if ($xml === false) return null;
    $root = $xml->children('urn:Belkin:device-1-0');
    if (!isset($root->device)) return null;
    $source = $root->device;
    $serial = trim((string)$source->serialNumber);
    $known = wemo_known_names();
    if (!isset($known[$serial])) return null;
    $control = null;
    if (isset($source->serviceList->service)) foreach ($source->serviceList->service as $service) {
        if ((string)$service->serviceType === 'urn:Belkin:service:basicevent:1') $control = (string)$service->controlURL;
    }
    if (!is_string($control) || !preg_match('#^/[A-Za-z0-9_./-]+$#D', $control)
        || substr($control, 0, 2) === '//') return null;
    return array('serial' => $serial, 'name' => $known[$serial], 'ip' => $parts['host'],
        'location' => $location, 'base_url' => 'http://' . $parts['host'] . ':' . $parts['port'],
        'control_url' => $control, 'endpointAt' => wemo_now_ms());
}
function wemo_fetch_descriptor($location, $deadline) {
    return wemo_parse_descriptor(wemo_http($location, 'GET', array(), '', $deadline), $location);
}
function wemo_soap_request($device, $action, $inner, $deadline) {
    if (!isset($device['base_url'], $device['control_url'])) return null;
    $body = '<?xml version="1.0" encoding="utf-8"?>'
        . '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        . '<s:Body><u:' . $action . ' xmlns:u="urn:Belkin:service:basicevent:1">' . $inner
        . '</u:' . $action . '></s:Body></s:Envelope>';
    return wemo_http($device['base_url'] . $device['control_url'], 'POST',
        array('Content-Type' => 'text/xml; charset="utf-8"',
            'SOAPACTION' => '"urn:Belkin:service:basicevent:1#' . $action . '"'), $body, $deadline);
}
function wemo_parse_binary($body, $action) {
    if (!is_string($body) || stripos($body, '<!DOCTYPE') !== false) return null;
    $previous = libxml_disable_entity_loader(true);
    $xml = @simplexml_load_string($body, 'SimpleXMLElement', LIBXML_NONET);
    libxml_disable_entity_loader($previous);
    if ($xml === false) return null;
    $faults = $xml->xpath('//*[local-name()="Fault"]');
    if (!empty($faults)) return null;
    $responses = $xml->xpath('//*[local-name()="' . $action . 'Response"]/*[local-name()="BinaryState"]');
    if (count($responses) !== 1) return null;
    $raw = trim((string)$responses[0]);
    if (!preg_match('/^([01])(?:\|[0-9|.]*)?$/D', $raw, $matches)) return null;
    return (int)$matches[1];
}
function wemo_record_result($serial, $descriptor, $state, $error, $startedAt, $deadline = null) {
    return wemo_registry_update(function ($registry) use ($serial, $descriptor, $state, $error, $startedAt) {
        if (!isset($registry['devices'][$serial])) return $registry;
        $device = $registry['devices'][$serial];
        // A late worker failure cannot overwrite a newer successful command.
        if (isset($device['checkedAt']) && $device['checkedAt'] > $startedAt) return $registry;
        if ($descriptor !== null) $device = array_merge($device, $descriptor);
        $device['checkedAt'] = wemo_now_ms();
        $device['online'] = $error === null;
        if ($error === null) {
            $device['state'] = $state;
            $device['observedAt'] = wemo_now_ms();
            unset($device['error']);
        } else $device['error'] = $error;
        $registry['devices'][$serial] = $device;
        return $registry;
    }, $deadline);
}
function wemo_public_device($device, $now = null) {
    if ($now === null) $now = wemo_now_ms();
    $seen = isset($device['observedAt']) && is_numeric($device['observedAt']) ? (float)$device['observedAt'] : null;
    $fresh = $seen !== null && $now >= $seen - 1000 && $now - $seen <= WEMO_STATE_MAX_AGE_MS;
    $state = isset($device['state']) && ($device['state'] === 0 || $device['state'] === 1) ? $device['state'] : null;
    $online = !empty($device['online']) && empty($device['identityAmbiguous']) && $fresh && $state !== null;
    $result = array('id' => $device['serial'], 'serial' => $device['serial'], 'ip' => $device['ip'],
        'name' => $device['name'], 'state' => $state === null ? null : ($state ? 'on' : 'off'),
        'state_value' => $state, 'online' => $online, 'observedAt' => $seen);
    if (!$online) $result['error'] = isset($device['error']) ? $device['error'] : 'stateStale';
    return $result;
}
function wemo_status_snapshot() {
    $registry = wemo_registry_load(); $now = wemo_now_ms(); $devices = array(); $online = 0;
    foreach ($registry['devices'] as $device) {
        $public = wemo_public_device($device, $now);
        if ($public['online']) $online++;
        $devices[] = $public;
    }
    $worker = $registry['workerObservedAt'];
    $age = $worker === null ? null : max(0, $now - $worker);
    $workerHealthy = $worker !== null && $worker <= $now + 1000 && $age <= WEMO_WORKER_MAX_AGE_MS;
    $health = array('healthy' => $registry['registryHealthy'] && $workerHealthy && $online === count($devices),
        'workerHealthy' => $workerHealthy, 'workerObservedAt' => $worker, 'workerAgeMs' => $age,
        'total' => count($devices), 'online' => $online, 'offline' => count($devices) - $online,
        'discoveryObservedAt' => $registry['discoveryObservedAt'], 'registryHealthy' => $registry['registryHealthy']);
    return array('ok' => true, 'devices' => $devices, 'observedAt' => $now, 'health' => $health);
}
function wemo_resolve_serial($deviceId, $ip, $registry) {
    if ($deviceId !== '') return isset($registry['devices'][$deviceId]) ? $deviceId : null;
    $matches = array();
    foreach ($registry['devices'] as $serial => $device) {
        if ($ip !== '' && $device['ip'] === $ip) $matches[] = $serial;
    }
    return count($matches) === 1 ? $matches[0] : null;
}
function wemo_command($serial, $desired, $deadline = null) {
    if ($deadline === null) $deadline = microtime(true) + WEMO_COMMAND_SECONDS;
    $registry = wemo_registry_load();
    if (!isset($registry['devices'][$serial])) return array('ok' => false, 'error' => 'Device not found.', 'code' => 404);
    $lock = wemo_lock('device-' . $serial, min($deadline, microtime(true) + 1.5));
    if ($lock === false) return array('ok' => false, 'error' => 'Device is busy.', 'code' => 503);
    $registry = wemo_registry_load(); $device = $registry['devices'][$serial];
    $started = wemo_now_ms(); $error = 'deviceOffline'; $confirmed = null; $verified = null;
    if (!empty($device['identityAmbiguous'])) $error = 'identityAmbiguous';
    elseif (isset($device['location'])) {
        $verified = wemo_fetch_descriptor($device['location'], min($deadline - 0.15, microtime(true) + 0.75));
        if ($verified === null) $error = 'deviceUnreachable';
        elseif ($verified['serial'] !== $serial) { $error = 'identityMismatch'; $verified = null; }
        else {
            $desired = $desired ? 1 : 0;
            for ($attempt = 0; $attempt < 2 && microtime(true) < $deadline - 0.2; $attempt++) {
                $response = wemo_soap_request($verified, 'SetBinaryState', '<BinaryState>' . $desired . '</BinaryState>',
                    min($deadline - 0.15, microtime(true) + 0.9));
                $confirmed = wemo_parse_binary($response, 'SetBinaryState');
                if ($confirmed !== $desired && microtime(true) < $deadline - 0.2) {
                    $confirmed = wemo_parse_binary(wemo_soap_request($verified, 'GetBinaryState', '',
                        min($deadline - 0.15, microtime(true) + 0.55)), 'GetBinaryState');
                }
                if ($confirmed === $desired) { $error = null; break; }
                $error = 'commandUnconfirmed';
            }
        }
    }
    $saved = wemo_record_result($serial, $verified, $confirmed, $error, $started, $deadline);
    $registry = wemo_registry_load();
    $public = wemo_public_device($registry['devices'][$serial]);
    wemo_unlock($lock);
    if (!$saved) return array('ok' => false, 'error' => 'State could not be saved.', 'code' => 503, 'device' => $public);
    if ($error !== null) return array('ok' => false, 'error' => $error, 'code' => 502, 'device' => $public);
    if (!$public['online']) return array('ok' => false, 'error' => isset($public['error']) ? $public['error'] : 'stateUnavailable', 'code' => 502, 'device' => $public);
    return array('ok' => true, 'device' => $public, 'observedAt' => wemo_now_ms(), 'code' => 200);
}

// Local UI and wemoctl compatibility: status reads are now disk-only too.
function wemo_get_devices($forceRefresh) {
    $registry = wemo_registry_load(); $devices = array(); $counts = array();
    foreach ($registry['devices'] as $device) if ($device['ip'] !== null) {
        $ip = $device['ip']; $counts[$ip] = isset($counts[$ip]) ? $counts[$ip] + 1 : 1;
    }
    foreach ($registry['devices'] as $serial => $device) {
        $key = $device['ip'] === null || $counts[$device['ip']] !== 1 ? $serial : $device['ip'];
        $devices[$key] = $device;
    }
    uasort($devices, 'wemo_compare_devices');
    return $devices;
}
function wemo_compare_devices($a, $b) { return strcasecmp($a['name'], $b['name']); }
function wemo_get_state($device) {
    $registry = wemo_registry_load();
    if (!isset($device['serial'], $registry['devices'][$device['serial']])) return null;
    $public = wemo_public_device($registry['devices'][$device['serial']]);
    return $public['online'] ? $public['state_value'] : null;
}
function wemo_get_device_state($device) { return wemo_get_state($device); }
function wemo_set_state($device, $state) {
    if (!isset($device['serial'])) return false;
    $result = wemo_command($device['serial'], $state);
    return $result['ok'];
}
function wemo_format_device_state($device, $state) {
    $registry = wemo_registry_load();
    return wemo_public_device(isset($registry['devices'][$device['serial']]) ? $registry['devices'][$device['serial']] : $device);
}
function wemo_collect_device_states($devices) {
    $snapshot = wemo_status_snapshot(); return $snapshot['devices'];
}
function wemo_find_device($devices, $needle) {
    $matches = array();
    foreach ($devices as $device) if ($device['serial'] === $needle || $device['ip'] === $needle || strcasecmp($device['name'], $needle) === 0) $matches[] = $device;
    return count($matches) === 1 ? $matches[0] : null;
}
function wemo_set_all_devices($devices, $desired) {
    $updated = array(); $failed = array(); $deadline = microtime(true) + WEMO_COMMAND_SECONDS;
    foreach ($devices as $device) {
        $result = wemo_command($device['serial'], $desired, $deadline);
        if (!$result['ok']) $failed[] = $device['name'];
        if (isset($result['device'])) $updated[] = $result['device'];
    }
    return array('devices' => $updated, 'failed_devices' => $failed);
}
function wemo_remote_config() {
    if (!is_file(WEMO_REMOTE_CONFIG_FILE)) return null;
    $config = include WEMO_REMOTE_CONFIG_FILE;
    return is_array($config) && isset($config['token']) && trim($config['token']) !== '' ? $config : null;
}
function wemo_remote_token_matches($token) {
    $config = wemo_remote_config();
    if ($config === null || !is_string($token)) return false;
    $expected = (string)$config['token'];
    if (function_exists('hash_equals')) return hash_equals($expected, $token);
    // PHP 5.4 has no hash_equals; compare every byte after the public length check.
    if (strlen($expected) !== strlen($token)) return false;
    $different = 0;
    for ($i = 0; $i < strlen($expected); $i++) $different |= ord($expected[$i]) ^ ord($token[$i]);
    return $different === 0;
}
