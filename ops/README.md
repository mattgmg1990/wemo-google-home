Operations for the Debian 7 Pi
=============================

The Pi uses SysV init, `/usr/bin/php` 5.4.4, and Python 2.7. This service adds only WeMo worker supervision. It does not restart or reconfigure Apache, Tailscale, the Pi, or unrelated projects. The existing secret file `/etc/wemo-remote.php` stays in place and is never copied into the bundle or backup.

From the final repository root, prepare a bundle:

```sh
node ops/build-bundle.mjs pi /path/to/wemo-bundle
```

Transfer the bundle to the Pi over the established, fingerprint-verified SSH connection. Verify its manifest and installer hashes against the builder output, then run:

```sh
sudo /usr/bin/python /path/to/wemo-bundle/install.py --dry-run /path/to/wemo-bundle
sudo /usr/bin/python /path/to/wemo-bundle/install.py --apply /path/to/wemo-bundle
```

The builder's two `beforeSha256` values are the independently observed production source hashes on 2026-10-18. A changed source file, existing new service file, or symlink causes installation to stop. A future upgrade requires a deliberately reviewed baseline and upgrade procedure; this installer intentionally handles the initial migration only.

Installation validates PHP and shell syntax first, preserves both original web files and their ownership/permissions under `/root/wemo-resilience-backups/<timestamp>-<manifest-hash>/`, and writes each new source file by temporary file plus atomic rename. This is atomic per file, not a simultaneous multi-file filesystem transaction. `lib.php` is installed before `remote.php`; the library must retain the old endpoint's helper API. Exceptions after writing trigger a stop and source restoration. If the owned service cannot stop, the installer retains files and prints the backup location for operator recovery.

The service starts automatically in runlevels 2–5. The Python supervisor and PHP worker both run as `www-data`. The supervisor PID file is root owned in `/run/wemo`; control commands validate the exact process command line before signaling it. A crashed worker restarts with 4–30 second backoff, returning to two seconds after a stable run. A heartbeat older than 120 seconds triggers a worker restart after an initial 120 second grace period. Linux parent-death signaling prevents an orphan worker when the supervisor is killed. A dedicated cron entry restores the supervisor within a minute if it dies.

`/var/lib/wemo` holds the durable registry and locks. Its owner is `www-data:www-data`, mode `0750`; the worker creates private state files. Logs are in `/var/log/wemo/worker.log`, with daily logrotate checks and a 256 KiB rotation threshold, retaining three compressed files.

```sh
sudo /etc/init.d/wemo-worker status
sudo /etc/init.d/wemo-worker restart
sudo /etc/init.d/wemo-worker stop
sudo /etc/init.d/wemo-worker start
```

An explicit stop creates `/etc/wemo-worker.disabled` so cron does not immediately undo the stop. A normal service start, including boot startup, clears it. Read bridge health through the existing authenticated `action=health` API; no additional network listener is installed. External monitoring can distinguish stale worker heartbeat, registry errors, and unreachable plugs without rebooting shared services.

The install result prints its backup path and rollback command. Rollback verifies every installed and original file hash before stopping anything, restores the prior web sources, removes only this service's files and SysV links, and retains `/var/lib/wemo` for diagnosis:

```sh
sudo /usr/bin/python /path/to/wemo-bundle/install.py --rollback /root/wemo-resilience-backups/EXACT-BACKUP-NAME
```

Tests run on the real Pi in isolated temporary directories, without controlling devices: `python ops/test_ops.py` covers ten file-integrity and heartbeat cases, including epoch milliseconds represented as Python 2 long integers; `sudo python ops/test_lifecycle.py` verifies privilege dropping, worker crash recovery, supervisor death cleanup, supervisor recovery, and clean shutdown using a dummy worker. The lifecycle test must run on Linux and only signals its own temporary processes.
