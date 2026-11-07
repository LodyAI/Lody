import copy
import fcntl
import importlib.util
import json
import multiprocessing
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name('simulator.py')


def load_simulator_module():
    if not MODULE_PATH.exists():
        return None
    spec = importlib.util.spec_from_file_location('lody_verify_simulator', MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hold_lock(path, ready, release):
    with Path(path).open('w') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        ready.set()
        release.wait(timeout=10)


class FakeSimctl:
    def __init__(
        self,
        inventory,
        fail_on=None,
        returncode_on=None,
        minimum_boot_timeout=None,
    ):
        self.inventory = copy.deepcopy(inventory)
        self.erase_counts = {}
        self.fail_on = fail_on
        self.returncode_on = returncode_on
        self.minimum_boot_timeout = minimum_boot_timeout

    def __call__(self, *command, check=True, timeout=120):
        if command[0] == self.fail_on:
            raise subprocess.CalledProcessError(1, command)
        if command[0] == self.returncode_on:
            return subprocess.CompletedProcess(command, 1, '', 'injected failure')
        if (
            command[0] == 'bootstatus'
            and self.minimum_boot_timeout is not None
            and timeout < self.minimum_boot_timeout
        ):
            raise subprocess.TimeoutExpired(command, timeout)
        if command == ('list', 'devices', '--json'):
            return subprocess.CompletedProcess(command, 0, json.dumps(self.inventory), '')
        if command[0] == 'create':
            device = {
                'udid': 'CREATED',
                'name': command[1],
                'state': 'Shutdown',
                'isAvailable': True,
                'deviceTypeIdentifier': command[2],
            }
            self.inventory['devices'].setdefault(command[3], []).append(device)
            return subprocess.CompletedProcess(command, 0, 'CREATED\n', '')

        device = self.device(command[1])
        if command[0] == 'shutdown':
            if device['state'] == 'Shutdown':
                return subprocess.CompletedProcess(
                    command,
                    149,
                    '',
                    'Unable to shutdown device in current state: Shutdown',
                )
            device['state'] = 'Shutdown'
        elif command[0] == 'erase':
            self.erase_counts[device['udid']] = self.erase_counts.get(device['udid'], 0) + 1
        elif command[0] == 'rename':
            device['name'] = command[2]
        elif command[0] == 'boot':
            device['state'] = 'Booted'
        elif command[0] != 'bootstatus':
            raise AssertionError(f'Unexpected simctl command: {command}')
        return subprocess.CompletedProcess(command, 0, '', '')

    def device(self, udid):
        for devices in self.inventory['devices'].values():
            for device in devices:
                if device['udid'] == udid:
                    return device
        raise AssertionError(f'Unknown fake device: {udid}')


class ReusableDeviceTests(unittest.TestCase):
    def test_watch_runtime_is_separate_from_iphone_pool(self):
        simulator = load_simulator_module()
        runtime = 'com.apple.CoreSimulator.SimRuntime.watchOS-27-0'
        watch = {'udid': 'WATCH', 'name': 'Lody Watch Verify', 'isAvailable': True,
                 'deviceTypeIdentifier': simulator.DEVICE_TYPES['watch']}
        inventory = {'devices': {runtime: [watch]}}
        self.assertEqual(simulator.reusable_devices(inventory), [])
        self.assertEqual(simulator.reusable_devices(inventory, simulator.DEVICE_TYPES['watch'], runtime), [watch])

    def test_only_lody_verify_devices_enter_the_reuse_pool(self):
        simulator = load_simulator_module()
        self.assertIsNotNone(simulator, 'simulator allocator module is missing')
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'LODY-VERIFY',
                        'name': 'Lody File Preview Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                    {
                        'udid': 'PERSONAL',
                        'name': 'iPhone 17 Pro',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                    {
                        'udid': 'OTHER-PROJECT',
                        'name': 'Yohaku Acceptance',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                    {
                        'udid': 'LODY-ACCEPTANCE',
                        'name': 'Lody iOS Acceptance',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                ]
            }
        }

        devices = simulator.reusable_devices(inventory)

        self.assertEqual([device['udid'] for device in devices], ['LODY-VERIFY'])

    def test_only_available_devices_with_the_pinned_model_and_runtime_are_reused(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'VALID',
                        'name': 'Lody Valid Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                    {
                        'udid': 'WRONG-TYPE',
                        'name': 'Lody Wrong Type Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
                    },
                    {
                        'udid': 'UNAVAILABLE',
                        'name': 'Lody Unavailable Verify',
                        'state': 'Shutdown',
                        'isAvailable': False,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                ],
                'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
                    {
                        'udid': 'WRONG-RUNTIME',
                        'name': 'Lody Wrong Runtime Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ],
            }
        }

        devices = simulator.reusable_devices(inventory)

        self.assertEqual([device['udid'] for device in devices], ['VALID'])

    def test_ipad_checks_select_only_the_pinned_ipad_model(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                simulator.RUNTIME: [
                    {
                        'udid': 'PHONE',
                        'name': 'Lody Phone Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': simulator.DEVICE_TYPES['iphone'],
                    },
                    {
                        'udid': 'PAD',
                        'name': 'Lody Pad Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': simulator.DEVICE_TYPES['ipad'],
                    },
                ]
            }
        }

        devices = simulator.reusable_devices(
            inventory, simulator.DEVICE_TYPES['ipad']
        )

        self.assertEqual([device['udid'] for device in devices], ['PAD'])

    def test_invalid_verify_names_are_rejected_before_creating_a_device(self):
        simulator = load_simulator_module()

        for name in ['', '   ', 'Line\nBreak']:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    simulator.managed_name(name)


class SimulatorLeaseTests(unittest.TestCase):
    def test_invalid_name_is_rejected_before_a_device_is_touched(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'PRESERVE',
                        'name': 'Lody Preserve Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory)

        with tempfile.TemporaryDirectory() as lock_directory:
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=Path(lock_directory)
            )
            with self.assertRaises(ValueError):
                with pool.lease('Line\nBreak'):
                    self.fail('invalid lease must not start')

            self.assertNotIn('PRESERVE', simctl.erase_counts)
            self.assertEqual(simctl.device('PRESERVE')['name'], 'Lody Preserve Verify')
            self.assertEqual(simctl.device('PRESERVE')['state'], 'Shutdown')

    def test_reuse_renames_and_releases_a_stale_booted_device(self):
        simulator = load_simulator_module()
        self.assertTrue(hasattr(simulator, 'SimulatorPool'), 'SimulatorPool is missing')
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'REUSABLE',
                        'name': 'Lody Old Verify',
                        'state': 'Booted',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory)

        with tempfile.TemporaryDirectory() as lock_directory:
            lock_directory = Path(lock_directory)
            (lock_directory / 'REUSABLE.managed').touch()
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=lock_directory
            )
            with pool.lease('File Preview') as udid:
                self.assertEqual(udid, 'REUSABLE')
                self.assertEqual(simctl.device(udid)['name'], 'Lody File Preview Verify')
                self.assertEqual(simctl.device(udid)['state'], 'Booted')
                self.assertNotIn(udid, simctl.erase_counts)

            self.assertEqual(simctl.device('REUSABLE')['state'], 'Shutdown')
            self.assertFalse((lock_directory / 'REUSABLE.managed').exists())

    def test_an_untracked_booted_device_is_treated_as_occupied(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'EXTERNAL',
                        'name': 'Lody External Verify',
                        'state': 'Booted',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                    {
                        'udid': 'IDLE',
                        'name': 'Lody Idle Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    },
                ]
            }
        }
        simctl = FakeSimctl(inventory)

        with tempfile.TemporaryDirectory() as lock_directory:
            lock_directory = Path(lock_directory)
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=lock_directory
            )
            with pool.lease('Settings') as udid:
                self.assertEqual(udid, 'IDLE')
                self.assertTrue((lock_directory / 'IDLE.managed').exists())
                self.assertEqual(simctl.device('EXTERNAL')['state'], 'Booted')
                self.assertEqual(
                    simctl.device('EXTERNAL')['name'], 'Lody External Verify'
                )

    def test_a_locked_device_is_not_reclaimed(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'BUSY',
                        'name': 'Lody Send Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory)

        with tempfile.TemporaryDirectory() as directory:
            lock_directory = Path(directory)
            busy_lock = lock_directory / 'BUSY.lock'
            ready = multiprocessing.Event()
            release = multiprocessing.Event()
            locker = multiprocessing.Process(
                target=hold_lock, args=(busy_lock, ready, release)
            )
            locker.start()
            self.assertTrue(ready.wait(timeout=5), 'fixture did not acquire the device lock')
            try:
                pool = simulator.SimulatorPool(
                    simctl=simctl, lock_directory=lock_directory
                )
                with pool.lease('Onboarding') as udid:
                    self.assertEqual(udid, 'CREATED')
                    self.assertEqual(simctl.device('BUSY')['name'], 'Lody Send Verify')
                    self.assertEqual(simctl.device('BUSY')['state'], 'Shutdown')
                    self.assertEqual(
                        simctl.device('CREATED')['name'], 'Lody Onboarding Verify'
                    )
            finally:
                release.set()
                locker.join(timeout=5)
                if locker.is_alive():
                    locker.kill()
                    locker.join()

    def test_a_failed_boot_is_shut_down_before_releasing_the_lock(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'BROKEN',
                        'name': 'Lody Broken Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory, fail_on='bootstatus')

        with tempfile.TemporaryDirectory() as lock_directory:
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=Path(lock_directory)
            )
            with self.assertRaises(subprocess.CalledProcessError):
                with pool.lease('Broken'):
                    self.fail('lease must not start after bootstatus fails')

            self.assertEqual(simctl.device('BROKEN')['state'], 'Shutdown')

    def test_fresh_boot_allows_slow_data_migration(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'SLOW-MIGRATION',
                        'name': 'Lody Slow Migration Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory, minimum_boot_timeout=180)

        with tempfile.TemporaryDirectory() as lock_directory:
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=Path(lock_directory)
            )
            try:
                with pool.lease('Slow Migration') as udid:
                    self.assertEqual(udid, 'SLOW-MIGRATION')
            except subprocess.TimeoutExpired as error:
                self.fail(f'bootstatus timeout was too short: {error.timeout}')

    def test_a_failed_release_surfaces_the_error_and_unlocks_for_recovery(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'SHUTDOWN-FAILURE',
                        'name': 'Lody Shutdown Failure Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory, returncode_on='shutdown')

        with tempfile.TemporaryDirectory() as directory:
            lock_directory = Path(directory)
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=lock_directory
            )
            lease = pool.lease('Shutdown Failure')
            with self.assertRaises(subprocess.CalledProcessError):
                with lease:
                    pass

            with (lock_directory / 'SHUTDOWN-FAILURE.lock').open('a+') as lock_file:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(
                (lock_directory / 'SHUTDOWN-FAILURE.managed').exists()
            )

    def test_release_failure_is_not_hidden_by_an_unrelated_caller_exception(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'AMBIENT-EXCEPTION',
                        'name': 'Lody Ambient Exception Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory, returncode_on='shutdown')

        with tempfile.TemporaryDirectory() as lock_directory:
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=Path(lock_directory)
            )
            try:
                raise RuntimeError('unrelated caller error')
            except RuntimeError:
                with self.assertRaises(subprocess.CalledProcessError):
                    with pool.lease('Ambient Exception'):
                        pass

    def test_release_accepts_a_device_the_wrapped_command_already_shut_down(self):
        simulator = load_simulator_module()
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'ALREADY-SHUTDOWN',
                        'name': 'Lody Already Shutdown Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory)

        with tempfile.TemporaryDirectory() as directory:
            lock_directory = Path(directory)
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=lock_directory
            )
            try:
                with pool.lease('Already Shutdown') as udid:
                    simctl.device(udid)['state'] = 'Shutdown'
            except subprocess.CalledProcessError as error:
                self.fail(f'already-shutdown release was rejected: {error}')

            self.assertFalse(
                (lock_directory / 'ALREADY-SHUTDOWN.managed').exists()
            )

    def test_command_receives_the_leased_udid_and_returns_its_exit_code(self):
        simulator = load_simulator_module()
        self.assertTrue(
            hasattr(simulator, 'run_with_simulator'), 'run_with_simulator is missing'
        )
        inventory = {
            'devices': {
                'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
                    {
                        'udid': 'COMMAND',
                        'name': 'Lody Command Verify',
                        'state': 'Shutdown',
                        'isAvailable': True,
                        'deviceTypeIdentifier': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                    }
                ]
            }
        }
        simctl = FakeSimctl(inventory)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'udid.txt'
            pool = simulator.SimulatorPool(
                simctl=simctl, lock_directory=Path(directory) / 'locks'
            )
            exit_code = simulator.run_with_simulator(
                pool,
                'Command',
                [
                    sys.executable,
                    '-c',
                    (
                        'import os, pathlib; '
                        'pathlib.Path(os.environ["OUTPUT"]).write_text('
                        'os.environ["LODY_VERIFY_UDID"]); '
                        'raise SystemExit(7)'
                    ),
                ],
                environment={'OUTPUT': str(output)},
            )

            self.assertEqual(exit_code, 7)
            self.assertEqual(output.read_text(), 'COMMAND')
            self.assertEqual(simctl.device('COMMAND')['state'], 'Shutdown')

class VerifyEntryPointTests(unittest.TestCase):
    def test_verify_commands_do_not_require_a_manually_supplied_udid(self):
        scripts = [
            MODULE_PATH.with_name('native.py'),
            MODULE_PATH.with_name('ui') / 'run.py',
        ]

        for script in scripts:
            with self.subTest(script=script.name):
                result = subprocess.run(
                    [sys.executable, str(script), '--help'],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertIn('[--udid UDID]', result.stdout)


if __name__ == '__main__':
    unittest.main()
