import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(f'lody_verify_{name}', HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def scratch_build(root, name='toolbar-repro-build'):
    path = root / name
    (path / 'Build' / 'Products').mkdir(parents=True)
    return path


def staged_checkout(root, name='lody-split.abcdef'):
    path = root / name
    (path / 'apps' / 'ios').mkdir(parents=True)
    (path / 'pnpm-workspace.yaml').write_text('packages: []\n')
    return path


class BuildDestinationTests(unittest.TestCase):
    def test_watch_build_without_a_lease_uses_the_watch_simulator(self):
        build = load('build')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(build.destination(None, 'watchsimulator'), 'generic/platform=watchOS Simulator')

    def test_an_explicit_destination_wins(self):
        build = load('build')

        self.assertEqual(build.destination('id=EXPLICIT'), 'id=EXPLICIT')

    def test_a_simulator_lease_builds_only_for_that_device(self):
        build = load('build')
        previous = os.environ.get('LODY_VERIFY_UDID')
        os.environ['LODY_VERIFY_UDID'] = 'LEASED'
        try:
            self.assertEqual(build.destination(None), 'id=LEASED')
        finally:
            if previous is None:
                del os.environ['LODY_VERIFY_UDID']
            else:
                os.environ['LODY_VERIFY_UDID'] = previous

    def test_without_a_lease_the_build_targets_the_generic_simulator(self):
        build = load('build')

        self.assertEqual(build.destination(None), 'generic/platform=iOS Simulator')


class ScratchDetectionTests(unittest.TestCase):
    def test_build_caches_and_staged_checkouts_are_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = scratch_build(root)
            checkout = staged_checkout(root)

            self.assertTrue(clean.is_scratch(cache))
            self.assertTrue(clean.is_scratch(checkout))

    def test_unrelated_directories_are_never_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = root / 'codex-smoothness.7OwJdg'
            (frames / 'Build').mkdir(parents=True)
            work = root / 'work'
            (work / 'lody-ios' / 'apps' / 'ios').mkdir(parents=True)
            similar = root / 'lody-notes'
            similar.mkdir()
            (similar / 'apps').mkdir()

            self.assertFalse(clean.is_scratch(frames))
            self.assertFalse(clean.is_scratch(work))
            self.assertFalse(clean.is_scratch(similar))
            self.assertFalse(clean.is_scratch(root))

    def test_a_bare_xcode_cache_root_is_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / 'ModuleCache.noindex'
            cache.mkdir()
            (root / 'SDKStatCaches.noindex').mkdir()

            self.assertTrue(clean.is_scratch(root))
            self.assertFalse(clean.is_scratch(cache))

    def test_recent_and_small_entries_stay_out_of_the_report(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scratch_build(root, 'lody-fresh.abcdef')
            large = scratch_build(root, 'old-build')
            (large / 'Build' / 'Products' / 'Lody.app').write_bytes(b'x' * 4096)
            old = 10 * 3600

            recent = clean.collect([root], older_than_hours=24, minimum_bytes=0)
            sized = clean.collect([root], older_than_hours=0, minimum_bytes=1024 * 1024)

            self.assertEqual([path.name for path, _, _ in recent], [])
            self.assertEqual([path.name for path, _, _ in sized], [])

            os.utime(large, (0, 0))
            aged = clean.collect([root], older_than_hours=old, minimum_bytes=0)
            self.assertEqual([path.name for path, _, _ in aged], ['old-build'])


class CleanupCommandTests(unittest.TestCase):
    def test_apply_removes_only_reported_scratch(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = scratch_build(root)
            bystander = root / 'toolbar-investigation'
            bystander.mkdir()
            (bystander / 'notes.md').write_text('keep\n')

            exit_code = clean.main(['--root', str(root), '--older-than', '0', '--apply'])

            self.assertEqual(exit_code, 0)
            self.assertFalse(cache.exists())
            self.assertTrue((bystander / 'notes.md').exists())

    def test_a_dry_run_reports_without_removing(self):
        clean = load('clean')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = scratch_build(root)

            result = subprocess.run(
                [sys.executable, str(HERE / 'clean.py'), '--root', str(root), '--older-than', '0'],
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertIn('Would remove 1 entries', result.stdout)
            self.assertIn('Pass --apply', result.stdout)
            self.assertTrue(cache.exists())


class NativeBuildTests(unittest.TestCase):
    def test_release_lease_keeps_normal_signing_and_only_builds_the_selected_architecture(self):
        build = load('build')
        arguments = build.parser.parse_args(['--configuration', 'Release', '--destination', 'id=DEVICE'])
        command = build.xcodebuild(arguments)
        self.assertIn('ONLY_ACTIVE_ARCH=YES', command)
        self.assertFalse(any('CODE_SIGNING_ALLOWED' in value for value in command))


if __name__ == '__main__':
    unittest.main()
