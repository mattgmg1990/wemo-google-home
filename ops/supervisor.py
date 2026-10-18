#!/usr/bin/python
"""Small Python 2.7/3 supervisor for the WeMo worker on Debian SysV systems."""
from __future__ import print_function
import errno
import ctypes
import fcntl
import json
import os
import pwd
import signal
import subprocess
import sys
import time

SELF = '/usr/local/lib/wemo/supervisor.py'
PYTHON = '/usr/bin/python'
WORKER = '/usr/local/lib/wemo/worker.php'
PIDFILE = '/run/wemo/supervisor.pid'
REGISTRY = '/var/lib/wemo/registry.json'
LOG = '/var/log/wemo/worker.log'
STOPPING = False
try:
    NUMBER_TYPES = (int, float, long)
except NameError:
    NUMBER_TYPES = (int, float)


def process_matches(pid):
    try:
        args = open('/proc/%d/cmdline' % pid, 'rb').read().split(b'\0')
        return args[:3] == [PYTHON.encode('ascii'), SELF.encode('ascii'), b'run']
    except (IOError, ValueError):
        return False


def running_pid():
    try:
        pid = int(open(PIDFILE).read().strip())
        return pid if pid > 1 and process_matches(pid) else None
    except (IOError, ValueError):
        return None


def log(message):
    print('%s %s' % (time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), message))
    sys.stdout.flush()


def stop_worker(child):
    if child.poll() is not None:
        return
    child.terminate()
    until = time.time() + 12
    while child.poll() is None and time.time() < until:
        time.sleep(0.1)
    if child.poll() is None:
        child.kill()
    child.wait()


def heartbeat_age(started):
    # A new worker gets two minutes to initialize before a stuck-loop restart.
    if time.time() - started < 120:
        return 0
    try:
        row = json.load(open(REGISTRY))
        stamp = row.get('workerObservedAt')
        if not isinstance(stamp, NUMBER_TYPES) or stamp <= 0 or stamp > (time.time() + 120) * 1000.0:
            return 999999
        return max(0, time.time() - stamp / 1000.0)
    except (IOError, ValueError, TypeError):
        return 999999


def stop_on_parent_death(expected_parent):
    # Prevent an orphan worker from retaining worker.lock if the supervisor is
    # killed before its orderly shutdown. prctl is supported by this Linux Pi.
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        os._exit(111)
    if os.getppid() != expected_parent:
        os._exit(112)


def run():
    global STOPPING
    os.umask(0o027)
    lock = open(PIDFILE, 'a+')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError as error:
        if error.errno in (errno.EAGAIN, errno.EACCES):
            return 0
        raise
    # An exclusive lock stays open throughout supervisor lifetime. PID is root
    # owned and immutable to the www-data worker; only this service can replace it.
    lock.seek(0)
    lock.truncate()
    lock.write(str(os.getpid()) + '\n')
    lock.flush()
    os.fsync(lock.fileno())
    account = pwd.getpwnam('www-data')
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    output = open(LOG, 'a', 1)
    os.dup2(output.fileno(), 1)
    os.dup2(output.fileno(), 2)

    def stopping(_signal, _frame):
        global STOPPING
        STOPPING = True
    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)
    child = None
    backoff = 2
    log('WeMo supervisor started')
    try:
        while not STOPPING:
            started = time.time()
            parent_pid = os.getpid()
            child = subprocess.Popen(['/usr/bin/php', WORKER], close_fds=True,
                                     preexec_fn=lambda: stop_on_parent_death(parent_pid))
            log('worker started pid=%d' % child.pid)
            while child.poll() is None and not STOPPING:
                if heartbeat_age(started) > 120:
                    log('worker heartbeat stale; restarting worker')
                    stop_worker(child)
                    break
                time.sleep(1)
            if STOPPING:
                stop_worker(child)
                break
            duration = time.time() - started
            backoff = 2 if duration >= 60 else min(30, backoff * 2)
            log('worker exited code=%s; retry in %ds' % (child.returncode, backoff))
            until = time.time() + backoff
            while not STOPPING and time.time() < until:
                time.sleep(0.5)
    finally:
        if child is not None:
            stop_worker(child)
        log('WeMo supervisor stopped')
        lock.close()
    return 0


def start():
    if running_pid():
        return 0
    sink = open('/dev/null', 'a+')
    subprocess.Popen([PYTHON, SELF, 'run'], stdin=sink, stdout=sink,
                     stderr=sink, close_fds=True, preexec_fn=os.setsid)
    for _ in range(30):
        if running_pid():
            print('WeMo supervisor started')
            return 0
        time.sleep(0.1)
    print('WeMo supervisor did not start', file=sys.stderr)
    return 1


def stop():
    pid = running_pid()
    if pid is None:
        return 0
    os.kill(pid, signal.SIGTERM)
    for _ in range(180):
        if not process_matches(pid):
            print('WeMo supervisor stopped')
            return 0
        time.sleep(0.1)
    # Refuse to kill unrelated/reused PIDs. The worker stop path has its own
    # bounded termination, so reaching this point needs operator attention.
    print('WeMo supervisor did not stop within 18 seconds', file=sys.stderr)
    return 1


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action == 'status':
        pid = running_pid()
        print('WeMo supervisor %s' % ('running pid=%d' % pid if pid else 'not running'))
        return 0 if pid else 3
    if os.geteuid() != 0:
        print('This service control action requires root', file=sys.stderr)
        return 1
    if action in ('start', 'ensure'):
        return start()
    if action == 'stop':
        return stop()
    if action == 'run':
        return run()
    print('Usage: supervisor.py start|stop|status|ensure|run', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
