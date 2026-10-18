#!/usr/bin/python
"""Hash-guarded, per-file atomic install and rollback; Python 2.7 compatible.

Run `sudo python install.py --dry-run bundle` before `--apply bundle`.
No secret configuration, Apache configuration, or Tailscale state is changed.
"""
from __future__ import print_function
import hashlib
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import time

TARGETS = {
    'lib.php': ('/var/www/wemo/lib.php', 0o644),
    'remote.php': ('/var/www/wemo/remote.php', 0o644),
    'worker.php': ('/usr/local/lib/wemo/worker.php', 0o644),
    'supervisor.py': ('/usr/local/lib/wemo/supervisor.py', 0o755),
    'init-wemo-worker': ('/etc/init.d/wemo-worker', 0o755),
    'cron-wemo-worker': ('/etc/cron.d/wemo-worker', 0o644),
    'logrotate-wemo-worker': ('/etc/logrotate.d/wemo-worker', 0o644)
}
ORDER = ['worker.php', 'supervisor.py', 'init-wemo-worker',
         'logrotate-wemo-worker', 'lib.php', 'remote.php', 'cron-wemo-worker']
BACKUP_ROOT = '/root/wemo-resilience-backups'
CONTROL = '/etc/init.d/wemo-worker'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def no_symlinks(path):
    current = os.path.abspath(path)
    while current != '/':
        if os.path.islink(current):
            raise RuntimeError('Refusing symlink in installation path: ' + current)
        current = os.path.dirname(current)


def current_bytes(path):
    no_symlinks(path)
    if not os.path.exists(path):
        return None
    if not stat.S_ISREG(os.stat(path).st_mode):
        raise RuntimeError('Target is not a regular file: ' + path)
    with open(path, 'rb') as handle:
        return handle.read()


def check_old(path, expected):
    data = current_bytes(path)
    actual = digest(data) if data is not None else None
    if actual != expected:
        raise RuntimeError('Live source changed; refusing to overwrite: ' + path)
    return data


def atomic_write(path, data, mode, uid=0, gid=0):
    no_symlinks(path)
    parent = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix='.wemo-install-', dir=parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(temporary, uid, gid)
        os.chmod(temporary, mode)
        os.rename(temporary, path)
        parent_fd = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def directory(path, mode, uid=0, gid=0):
    no_symlinks(path)
    if not os.path.exists(path):
        os.mkdir(path, mode)
        os.chown(path, uid, gid)
        os.chmod(path, mode)
    info = os.stat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError('Unsafe directory ownership or permissions: ' + path)


def read_bundle(bundle):
    with open(os.path.join(bundle, 'manifest.json'), 'rb') as handle:
        raw = handle.read()
    manifest = json.loads(raw.decode('utf-8'))
    if manifest.get('schema') != 1 or set(manifest.get('files', {})) != set(TARGETS):
        raise RuntimeError('Unexpected bundle manifest')
    payload = {}
    before = {}
    for name in ORDER:
        item = manifest['files'][name]
        with open(os.path.join(bundle, name), 'rb') as handle:
            payload[name] = handle.read()
        if digest(payload[name]) != item.get('sha256'):
            raise RuntimeError('Candidate hash mismatch: ' + name)
        path = TARGETS[name][0]
        before[name] = check_old(path, item.get('beforeSha256'))
        if name not in ('lib.php', 'remote.php') and before[name] is not None:
            raise RuntimeError('New service file already exists: ' + path)
        if name in ('lib.php', 'remote.php') and before[name] is None:
            raise RuntimeError('Expected legacy WeMo source is missing: ' + path)
    if os.path.lexists('/etc/wemo-worker.disabled'):
        raise RuntimeError('Existing worker disable flag needs review')
    return manifest, digest(raw), payload, before


def validate_syntax(bundle):
    for name in ('lib.php', 'remote.php', 'worker.php'):
        subprocess.check_call(['/usr/bin/php', '-l', os.path.join(bundle, name)])
    subprocess.check_call(['/bin/sh', '-n', os.path.join(bundle, 'init-wemo-worker')])
    # compile() validates without writing bytecode into source folders.
    path = os.path.join(bundle, 'supervisor.py')
    with open(path, 'rb') as handle:
        compile(handle.read(), path, 'exec')


def backup_source(manifest, manifest_hash, before):
    directory(BACKUP_ROOT, 0o700)
    label = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + manifest_hash[:12]
    backup = os.path.join(BACKUP_ROOT, label)
    if os.path.exists(backup):
        raise RuntimeError('Backup already exists; refusing to overwrite')
    directory(backup, 0o700)
    receipt = {'schema': 1, 'manifestSha256': manifest_hash,
               'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'files': {}}
    for name in ORDER:
        path, mode = TARGETS[name]
        old = before[name]
        item = {'target': path, 'installedSha256': manifest['files'][name]['sha256'],
                'beforeSha256': digest(old) if old is not None else None}
        if old is not None:
            info = os.stat(path)
            item.update({'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid})
            atomic_write(os.path.join(backup, name + '.before'), old, 0o600)
        receipt['files'][name] = item
    atomic_write(os.path.join(backup, 'receipt.json'),
                 (json.dumps(receipt, sort_keys=True, indent=2) + '\n').encode('utf-8'), 0o600)
    return backup, receipt


def restore_files(backup, receipt, names):
    for name in reversed(names):
        item = receipt['files'][name]
        path = TARGETS[name][0]
        if item['beforeSha256'] is None:
            if os.path.lexists(path):
                os.unlink(path)
        else:
            with open(os.path.join(backup, name + '.before'), 'rb') as handle:
                data = handle.read()
            if digest(data) != item['beforeSha256']:
                raise RuntimeError('Backup integrity check failed: ' + name)
            atomic_write(path, data, item['mode'], item['uid'], item['gid'])


def apply(bundle):
    manifest, manifest_hash, payload, before = read_bundle(bundle)
    validate_syntax(bundle)
    account = pwd.getpwnam('www-data')
    directory('/usr/local/lib/wemo', 0o755)
    directory('/var/lib/wemo', 0o750, account.pw_uid, account.pw_gid)
    directory('/var/log/wemo', 0o750, account.pw_uid, account.pw_gid)
    directory('/run/wemo', 0o755)
    backup, receipt = backup_source(manifest, manifest_hash, before)
    installed = []
    try:
        for name in ORDER:
            path, mode = TARGETS[name]
            check_old(path, manifest['files'][name].get('beforeSha256'))
            atomic_write(path, payload[name], mode)
            installed.append(name)
        subprocess.check_call(['/usr/sbin/update-rc.d', 'wemo-worker', 'defaults'])
        subprocess.check_call([CONTROL, 'start'])
        subprocess.check_call([CONTROL, 'status'])
    except Exception:
        # Disable our cron first, then stop only our supervisor before restore.
        if 'init-wemo-worker' in installed and 'supervisor.py' in installed:
            if subprocess.call([CONTROL, 'stop']) != 0:
                raise RuntimeError('Install failed and worker stop needs operator attention; retained source and backup: ' + backup)
        subprocess.call(['/usr/sbin/update-rc.d', '-f', 'wemo-worker', 'remove'])
        restore_files(backup, receipt, installed)
        if os.path.isfile('/etc/wemo-worker.disabled'):
            os.unlink('/etc/wemo-worker.disabled')
        print('Install failed; restored original source. Backup: ' + backup, file=sys.stderr)
        raise
    print(json.dumps({'installed': True, 'backup': backup, 'manifestSha256': manifest_hash,
                      'rollbackCommand': 'sudo /usr/bin/python install.py --rollback ' + backup}))


def rollback(backup):
    backup = os.path.abspath(backup)
    if os.path.dirname(backup) != BACKUP_ROOT:
        raise RuntimeError('Rollback requires one direct child of the dedicated backup directory')
    directory(backup, 0o700)
    with open(os.path.join(backup, 'receipt.json'), 'rb') as handle:
        receipt = json.load(handle)
    if receipt.get('schema') != 1 or set(receipt.get('files', {})) != set(TARGETS):
        raise RuntimeError('Invalid backup receipt')
    # Verify ALL hashes, including backup bytes, before stopping or restoring.
    for name in ORDER:
        item = receipt['files'][name]
        if item['target'] != TARGETS[name][0]:
            raise RuntimeError('Unexpected backup target')
        check_old(TARGETS[name][0], item['installedSha256'])
        if item['beforeSha256'] is not None:
            with open(os.path.join(backup, name + '.before'), 'rb') as handle:
                if digest(handle.read()) != item['beforeSha256']:
                    raise RuntimeError('Backup integrity check failed: ' + name)
    subprocess.check_call([CONTROL, 'stop'])
    subprocess.check_call(['/usr/sbin/update-rc.d', '-f', 'wemo-worker', 'remove'])
    restore_files(backup, receipt, ORDER)
    if os.path.isfile('/etc/wemo-worker.disabled'):
        os.unlink('/etc/wemo-worker.disabled')
    print(json.dumps({'rolledBack': True, 'retainedRegistry': '/var/lib/wemo', 'backup': backup}))


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ('--dry-run', '--apply', '--rollback'):
        raise RuntimeError('Usage: install.py --dry-run|--apply BUNDLE or --rollback BACKUP')
    if os.geteuid() != 0:
        raise RuntimeError('Run with sudo on the Pi')
    action, path = sys.argv[1:]
    if action == '--dry-run':
        manifest, manifest_hash, payload, before = read_bundle(path)
        validate_syntax(path)
        print(json.dumps({'dryRun': True, 'filesVerified': len(payload), 'manifestSha256': manifest_hash}))
    elif action == '--apply':
        apply(path)
    else:
        rollback(path)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
