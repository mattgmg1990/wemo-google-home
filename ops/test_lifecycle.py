"""Root-only isolated lifecycle test. Never references production worker paths."""
from __future__ import print_function
import os
import pwd
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def await_value(predicate, timeout=12):
    until = time.time() + timeout
    while time.time() < until:
        result = predicate()
        if result:
            return result
        time.sleep(0.2)
    raise RuntimeError('Lifecycle fixture timed out')


def read_pid(path):
    try:
        return int(open(path).read().strip())
    except (IOError, ValueError):
        return None


def matches(pid, path):
    if pid is None:
        return False
    try:
        return path.encode('utf-8') in open('/proc/%d/cmdline' % pid, 'rb').read().split(b'\0')
    except IOError:
        return False


def main():
    if os.geteuid() != 0:
        raise RuntimeError('This isolated privilege-drop test needs sudo')
    root = tempfile.mkdtemp(prefix='wemo-supervisor-lifecycle-')
    os.chmod(root, 0o755)
    data = root + '/data'
    os.mkdir(data, 0o750)
    account = pwd.getpwnam('www-data')
    os.chown(data, account.pw_uid, account.pw_gid)
    source = open(os.path.join(os.path.dirname(__file__), 'supervisor.py')).read()
    changes = {'/usr/local/lib/wemo/supervisor.py': root + '/supervisor.py',
               '/usr/local/lib/wemo/worker.php': root + '/worker.php',
               '/run/wemo/supervisor.pid': root + '/supervisor.pid',
               '/var/lib/wemo/registry.json': data + '/registry.json',
               '/var/log/wemo/worker.log': data + '/worker.log'}
    for before, after in changes.items():
        source = source.replace(before, after)
    supervisor_path = root + '/supervisor.py'
    worker_path = root + '/worker.php'
    worker_pidfile = data + '/worker.pid'
    with open(supervisor_path, 'w') as handle:
        handle.write(source)
    with open(worker_path, 'w') as handle:
        handle.write('<?php file_put_contents(%r, getmypid()); while (true) { sleep(1); }\n' % worker_pidfile)
    command = ['/usr/bin/python', supervisor_path]
    worker_pid = None
    supervisor_pid = None
    try:
        subprocess.check_call(command + ['start'])
        worker_pid = await_value(lambda: read_pid(worker_pidfile))
        supervisor_pid = read_pid(root + '/supervisor.pid')
        assert matches(worker_pid, worker_path)
        assert os.stat('/proc/%d' % worker_pid).st_uid == account.pw_uid
        assert os.stat('/proc/%d' % supervisor_pid).st_uid == account.pw_uid
        assert os.stat(root + '/supervisor.pid').st_uid == 0
        print('PASS root-owned PID; supervisor and worker are www-data')
        os.kill(worker_pid, signal.SIGKILL)
        old_worker = worker_pid
        worker_pid = await_value(lambda: read_pid(worker_pidfile) if read_pid(worker_pidfile) != old_worker else None)
        assert matches(worker_pid, worker_path)
        print('PASS worker crash automatically restarted')
        os.kill(supervisor_pid, signal.SIGKILL)
        await_value(lambda: not matches(worker_pid, worker_path))
        print('PASS supervisor death terminates orphan worker')
        subprocess.check_call(command + ['ensure'])
        old_worker = worker_pid
        worker_pid = await_value(lambda: read_pid(worker_pidfile) if read_pid(worker_pidfile) != old_worker else None)
        supervisor_pid = read_pid(root + '/supervisor.pid')
        assert matches(worker_pid, worker_path)
        print('PASS ensure restores crashed supervisor')
        subprocess.check_call(command + ['stop'])
        assert not matches(worker_pid, worker_path)
        assert not matches(supervisor_pid, supervisor_path)
        print('PASS orderly stop leaves no worker or supervisor')
    finally:
        subprocess.call(command + ['stop'])
        if matches(worker_pid, worker_path):
            os.kill(worker_pid, signal.SIGTERM)
        shutil.rmtree(root)


if __name__ == '__main__':
    main()
