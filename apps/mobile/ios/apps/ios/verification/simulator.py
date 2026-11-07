"""Lease reusable Simulators for local Lody verification."""

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys


DEVICE_TYPES = {
    'iphone': 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
    'watch': 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-9-45mm',
    'watch-small': 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-SE-3-40mm',
    'ipad': 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2',
}
RUNTIME = os.environ.get('LODY_VERIFY_RUNTIME', 'com.apple.CoreSimulator.SimRuntime.iOS-27-0')
MANAGED_NAME = re.compile(r'^Lody .+ Verify$')


def reusable_devices(inventory, device_type=DEVICE_TYPES['iphone'], runtime=RUNTIME):
    devices = inventory.get('devices', {}).get(runtime, [])
    return [
        device
        for device in devices
        if device.get('isAvailable')
        and device.get('deviceTypeIdentifier') == device_type
        and MANAGED_NAME.fullmatch(device.get('name', ''))
    ]


def managed_name(verify_name):
    verify_name = verify_name.strip()
    if not verify_name or any(ord(character) < 32 for character in verify_name):
        raise ValueError('verification name must be non-empty and single-line')
    return f'Lody {verify_name} Verify'


def run_simctl(*command, check=True, timeout=120):
    return subprocess.run(
        ['xcrun', 'simctl', *command],
        check=check,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class SimulatorPool:
    def __init__(self, simctl=run_simctl, lock_directory=None, device_type=DEVICE_TYPES['iphone'], runtime=RUNTIME):
        self.runtime = runtime
        self.simctl = simctl
        self.device_type = device_type
        self.lock_directory = lock_directory or (
            Path.home() / 'Library/Caches/ai.lody.mobile/verify-simulators'
        )

    def acquire_lock(self, name, blocking):
        lock_file = (self.lock_directory / name).open('a+')
        flags = fcntl.LOCK_EX
        if not blocking:
            flags |= fcntl.LOCK_NB
        try:
            fcntl.flock(lock_file, flags)
        except BlockingIOError:
            lock_file.close()
            return None
        return lock_file

    @contextmanager
    def lease(self, verify_name):
        name = managed_name(verify_name)
        self.lock_directory.mkdir(parents=True, exist_ok=True)
        pool_lock = self.acquire_lock('.pool.lock', blocking=True)
        device_lock = None
        try:
            inventory = json.loads(self.simctl('list', 'devices', '--json').stdout)
            device = None
            candidates = sorted(
                reusable_devices(inventory, self.device_type, self.runtime),
                key=lambda candidate: candidate.get('state') != 'Shutdown',
            )
            for candidate in candidates:
                marker = self.lock_directory / f"{candidate['udid']}.managed"
                if candidate.get('state') != 'Shutdown' and not marker.exists():
                    continue
                candidate_lock = self.acquire_lock(
                    f"{candidate['udid']}.lock", blocking=False
                )
                if candidate_lock is not None:
                    device = candidate
                    device_lock = candidate_lock
                    break
            if device is None:
                created = self.simctl('create', name, self.device_type, self.runtime)
                udid = created.stdout.strip()
                device = {'udid': udid, 'name': name, 'state': 'Shutdown'}
                device_lock = self.acquire_lock(f'{udid}.lock', blocking=True)
            (self.lock_directory / f"{device['udid']}.managed").touch()
        finally:
            pool_lock.close()

        udid = device['udid']
        marker = self.lock_directory / f'{udid}.managed'
        operation_failed = False
        try:
            if device.get('state') != 'Shutdown':
                self.simctl('shutdown', udid)
            self.simctl('rename', udid, name)
            self.simctl('boot', udid)
            self.simctl('bootstatus', udid, '-b', timeout=300)
            yield udid
        except BaseException:
            operation_failed = True
            raise
        finally:
            cleanup_error = None
            try:
                shutdown = self.simctl('shutdown', udid, check=False)
                if shutdown.returncode != 0:
                    inventory = json.loads(
                        self.simctl('list', 'devices', '--json').stdout
                    )
                    current = next(
                        (
                            candidate
                            for devices in inventory.get('devices', {}).values()
                            for candidate in devices
                            if candidate.get('udid') == udid
                        ),
                        None,
                    )
                    if current is None or current.get('state') != 'Shutdown':
                        shutdown.check_returncode()
                marker.unlink(missing_ok=True)
            except Exception as error:
                cleanup_error = error
            finally:
                device_lock.close()
            if cleanup_error is not None:
                if operation_failed:
                    print(
                        f'Failed to release Simulator {udid}: {cleanup_error}',
                        file=sys.stderr,
                    )
                else:
                    raise cleanup_error


def run_with_simulator(pool, verify_name, command, environment=None):
    child_environment = os.environ.copy()
    child_environment.update(environment or {})
    with pool.lease(verify_name) as udid:
        child_environment['LODY_VERIFY_UDID'] = udid
        return subprocess.run(command, env=child_environment).returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--name',
        required=True,
        help='Current verification name, for example "File Preview"',
    )
    parser.add_argument('--device', choices=DEVICE_TYPES, default='iphone')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command
    if command and command[0] == '--':
        command = command[1:]
    if not command:
        parser.error('a command is required after --')
    try:
        managed_name(args.name)
    except ValueError as error:
        parser.error(str(error))
    return run_with_simulator(
        SimulatorPool(
            device_type=DEVICE_TYPES[args.device],
            runtime='com.apple.CoreSimulator.SimRuntime.watchOS-27-0' if args.device.startswith('watch') else RUNTIME,
        ), args.name, command
    )


if __name__ == '__main__':
    sys.exit(main())
