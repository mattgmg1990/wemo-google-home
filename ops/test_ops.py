from __future__ import print_function
import hashlib
import json
import os
import shutil
import tempfile
import time
import unittest

import install
import supervisor


class InstallGuardTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='wemo-ops-fixture-')

    def tearDown(self):
        shutil.rmtree(self.root)

    def write(self, name, value):
        path = os.path.join(self.root, name)
        with open(path, 'wb') as handle:
            handle.write(value)
        return path

    def test_refuses_modified_live_source(self):
        path = self.write('source.php', b'current')
        self.assertRaises(RuntimeError, install.check_old, path, install.digest(b'old'))
        self.assertEqual(open(path, 'rb').read(), b'current')

    def test_new_targets_must_be_absent(self):
        missing = os.path.join(self.root, 'missing')
        self.assertIsNone(install.check_old(missing, None))
        path = self.write('exists', b'')
        self.assertRaises(RuntimeError, install.check_old, path, None)

    def test_refuses_symlink_targets_and_parent_directories(self):
        real = self.write('real', b'original')
        link = os.path.join(self.root, 'linked')
        os.symlink(real, link)
        self.assertRaises(RuntimeError, install.current_bytes, link)
        linked_dir = os.path.join(self.root, 'linked-directory')
        os.symlink(self.root, linked_dir)
        self.assertRaises(RuntimeError, install.current_bytes, os.path.join(linked_dir, 'missing'))

    def test_atomic_write_replaces_whole_file_with_requested_mode(self):
        path = self.write('source', b'before')
        install.atomic_write(path, b'after', 0o640, os.getuid(), os.getgid())
        self.assertEqual(open(path, 'rb').read(), b'after')
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o640)
        self.assertFalse(any(name.startswith('.wemo-install-') for name in os.listdir(self.root)))

    def test_restore_checks_backup_integrity_before_overwriting(self):
        path = self.write('source', b'installed')
        self.write('lib.php.before', b'tampered')
        old_targets = install.TARGETS
        try:
            install.TARGETS = {'lib.php': (path, 0o644)}
            receipt = {'files': {'lib.php': {'beforeSha256': install.digest(b'original'),
                       'mode': 0o644, 'uid': os.getuid(), 'gid': os.getgid()}}}
            self.assertRaises(RuntimeError, install.restore_files, self.root, receipt, ['lib.php'])
            self.assertEqual(open(path, 'rb').read(), b'installed')
        finally:
            install.TARGETS = old_targets


class SupervisorHealthTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='wemo-supervisor-fixture-')
        self.previous_registry = supervisor.REGISTRY
        supervisor.REGISTRY = os.path.join(self.root, 'registry.json')

    def tearDown(self):
        supervisor.REGISTRY = self.previous_registry
        shutil.rmtree(self.root)

    def write_heartbeat(self, age):
        with open(supervisor.REGISTRY, 'w') as handle:
            json.dump({'workerObservedAt': (time.time() - age) * 1000.0}, handle)

    def test_initialization_grace_works_without_registry(self):
        self.assertEqual(supervisor.heartbeat_age(time.time()), 0)

    def test_missing_registry_is_unhealthy_after_grace(self):
        self.assertGreater(supervisor.heartbeat_age(time.time() - 200), 120)

    def test_millisecond_heartbeat_accepts_fresh_and_rejects_stale(self):
        self.write_heartbeat(2)
        self.assertLess(supervisor.heartbeat_age(time.time() - 200), 5)
        self.write_heartbeat(130)
        self.assertGreater(supervisor.heartbeat_age(time.time() - 200), 120)

    def test_other_process_is_never_accepted_as_supervisor(self):
        self.assertFalse(supervisor.process_matches(os.getpid()))
        self.assertFalse(supervisor.process_matches(999999999))

    def test_large_integer_milliseconds_work_on_32_bit_python(self):
        with open(supervisor.REGISTRY, 'w') as handle:
            json.dump({'workerObservedAt': int(time.time() * 1000)}, handle)
        self.assertLess(supervisor.heartbeat_age(time.time() - 200), 5)


if __name__ == '__main__':
    unittest.main()
