<?php
require_once is_file(__DIR__ . '/lib.php') ? __DIR__ . '/lib.php' : '/var/www/wemo/lib.php';

function wemo_worker_heartbeat($discoveryAt = null) {
    return wemo_registry_update(function ($registry) use ($discoveryAt) {
        $registry['workerObservedAt'] = wemo_now_ms();
        if ($discoveryAt !== null) $registry['discoveryObservedAt'] = $discoveryAt;
        return $registry;
    });
}
function wemo_worker_bootstrap() {
    $current = wemo_registry_load();
    if ($current['registryHealthy']) return true;
    $legacy = @json_decode(@file_get_contents(WEMO_LEGACY_CACHE_FILE), true);
    $candidates = is_array($legacy) && isset($legacy['devices']) && is_array($legacy['devices']) ? $legacy['devices'] : array();
    return wemo_registry_update(function ($registry) use ($candidates) {
        foreach ($candidates as $candidate) {
            if (!is_array($candidate) || !isset($candidate['serial'], $candidate['location'])) continue;
            $serial = $candidate['serial'];
            if (!isset($registry['devices'][$serial])) continue;
            $parts = wemo_url_parts($candidate['location']);
            if ($parts === null) continue;
            // Only an address hint: never trust cached XML's binaryState as live.
            $registry['devices'][$serial]['location'] = $candidate['location'];
            $registry['devices'][$serial]['ip'] = $parts['host'];
        }
        return $registry;
    });
}
function wemo_discover_locations($seconds) {
    $socket = @socket_create(AF_INET, SOCK_DGRAM, SOL_UDP);
    if ($socket === false) return array();
    @socket_set_option($socket, SOL_IP, IP_MULTICAST_TTL, 2);
    @socket_set_nonblock($socket);
    $message = "M-SEARCH * HTTP/1.1\r\nHOST:239.255.255.250:1900\r\nMAN:\"ssdp:discover\"\r\nMX:1\r\nST:urn:Belkin:device:**\r\n\r\n";
    @socket_sendto($socket, $message, strlen($message), 0, '239.255.255.250', 1900);
    $deadline = microtime(true) + $seconds; $locations = array();
    while (count($locations) < 12 && microtime(true) < $deadline) {
        $remaining = $deadline - microtime(true);
        $read = array($socket); $write = null; $except = null;
        if (@socket_select($read, $write, $except, (int)$remaining, (int)(($remaining - (int)$remaining) * 1000000)) < 1) break;
        $buffer = ''; $from = ''; $port = 0;
        if (@socket_recvfrom($socket, $buffer, 8192, 0, $from, $port) < 1) continue;
        if (!preg_match('/(?:^|\r?\n)location:\s*([^\r\n]+)/i', $buffer, $match)) continue;
        $location = trim($match[1]); $parts = wemo_url_parts($location);
        if ($parts !== null && $parts['host'] === $from) $locations[$location] = true;
    }
    socket_close($socket);
    return array_keys($locations);
}
function wemo_merge_discovery($descriptors, $ambiguous = array()) {
    return wemo_registry_update(function ($registry) use ($descriptors, $ambiguous) {
        foreach ($ambiguous as $serial => $unused) {
            if (isset($registry['devices'][$serial])) {
                $registry['devices'][$serial]['online'] = false;
                $registry['devices'][$serial]['identityAmbiguous'] = true;
                $registry['devices'][$serial]['error'] = 'identityAmbiguous';
            }
        }
        foreach ($descriptors as $serial => $descriptor) {
            if (!isset($registry['devices'][$serial]) || isset($ambiguous[$serial])) continue;
            $current = $registry['devices'][$serial];
            if (isset($current['endpointAt']) && $current['endpointAt'] > $descriptor['endpointAt']) continue;
            foreach ($registry['devices'] as $otherSerial => $other) {
                if ($otherSerial !== $serial && $other['ip'] === $descriptor['ip']) {
                    $registry['devices'][$otherSerial]['online'] = false;
                    $registry['devices'][$otherSerial]['error'] = 'identityMismatch';
                }
            }
            if ($current['ip'] !== $descriptor['ip']) {
                $current['online'] = false;
                $current['error'] = 'stateStale';
            }
            $current['identityAmbiguous'] = false;
            $registry['devices'][$serial] = array_merge($current, $descriptor);
        }
        $registry['discoveryObservedAt'] = wemo_now_ms();
        $registry['workerObservedAt'] = wemo_now_ms();
        return $registry;
    });
}
function wemo_worker_discover() {
    wemo_worker_heartbeat();
    $locations = wemo_discover_locations(2.0);
    $deadline = microtime(true) + 4.0; $found = array(); $ambiguous = array();
    foreach ($locations as $location) {
        if (microtime(true) >= $deadline) break;
        $descriptor = wemo_fetch_descriptor($location, min($deadline, microtime(true) + 0.6));
        if ($descriptor === null) continue;
        $serial = $descriptor['serial'];
        if (isset($found[$serial]) && $found[$serial]['ip'] !== $descriptor['ip']) $ambiguous[$serial] = true;
        $found[$serial] = $descriptor;
    }
    return wemo_merge_discovery($found, $ambiguous);
}
function wemo_worker_poll($serial) {
    // Polls yield immediately to commands, and never hold the registry lock on I/O.
    $lock = wemo_lock('device-' . $serial, microtime(true));
    if ($lock === false) return true;
    $registry = wemo_registry_load();
    if (!isset($registry['devices'][$serial])) { wemo_unlock($lock); return false; }
    $device = $registry['devices'][$serial]; $started = wemo_now_ms();
    $deadline = microtime(true) + 1.5; $verified = null; $state = null; $error = 'notDiscovered';
    if (!empty($device['identityAmbiguous'])) $error = 'identityAmbiguous';
    elseif (isset($device['location'])) {
        $verified = wemo_fetch_descriptor($device['location'], min($deadline, microtime(true) + 0.6));
        if ($verified === null) $error = 'deviceUnreachable';
        elseif ($verified['serial'] !== $serial) { $verified = null; $error = 'identityMismatch'; }
        else {
            $state = wemo_parse_binary(wemo_soap_request($verified, 'GetBinaryState', '', min($deadline, microtime(true) + 0.7)), 'GetBinaryState');
            $error = $state === null ? 'stateUnavailable' : null;
        }
    }
    $saved = wemo_record_result($serial, $verified, $state, $error, $started);
    wemo_unlock($lock);
    return $saved;
}
function wemo_worker_stop($signal) { $GLOBALS['wemo_worker_stop'] = true; }
function wemo_worker_main($once) {
    if (PHP_SAPI !== 'cli') return 1;
    umask(0077);
    $lock = wemo_lock('worker', microtime(true));
    if ($lock === false) { fwrite(STDERR, "Worker already running or state directory unavailable.\n"); return 1; }
    if (!wemo_worker_bootstrap()) { wemo_unlock($lock); fwrite(STDERR, "Cannot initialize registry.\n"); return 1; }
    $GLOBALS['wemo_worker_stop'] = false;
    if (function_exists('pcntl_signal')) {
        pcntl_signal(SIGTERM, 'wemo_worker_stop'); pcntl_signal(SIGINT, 'wemo_worker_stop');
    }
    $nextDiscovery = 0; $nextPoll = 0;
    do {
        $now = microtime(true);
        if ($now >= $nextDiscovery) { wemo_worker_discover(); $nextDiscovery = microtime(true) + 60; }
        if ($now >= $nextPoll || $once) {
            foreach (wemo_known_names() as $serial => $name) {
                if (!wemo_worker_heartbeat() || !wemo_worker_poll($serial)) {
                    wemo_unlock($lock); fwrite(STDERR, "Cannot update registry.\n"); return 1;
                }
            }
            wemo_worker_heartbeat(); $nextPoll = microtime(true) + 10;
        }
        if ($once) break;
        if (function_exists('pcntl_signal_dispatch')) pcntl_signal_dispatch();
        if (!$GLOBALS['wemo_worker_stop']) usleep(250000);
    } while (!$GLOBALS['wemo_worker_stop']);
    wemo_unlock($lock);
    return 0;
}
if (!defined('WEMO_WORKER_LIBRARY_ONLY')) exit(wemo_worker_main(in_array('--once', $argv, true)));
