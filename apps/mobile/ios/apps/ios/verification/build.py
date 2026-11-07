#!/usr/bin/env python3
"""Build the Simulator app for verification on one shared build cache.

Both Debug and Release use the standalone UIKit application entry point.

Verification always builds this same project, so it must reuse one Xcode
DerivedData instead of writing a fresh multi-GB cache per task. Unless
``--derived-data`` is given, the build lands in Xcode's own ``DerivedData/Lody-*``
for this project - the directory normal Xcode use already maintains - so a
rebuild after a source change reuses the previous products.

    pnpm verify:build                      # app path on stdout, progress on stderr
    pnpm verify:ui --app "$(pnpm --silent verify:build)"

Inside ``pnpm verify:simulator`` the lease exports ``LODY_VERIFY_UDID`` and the
build targets that device (one architecture); otherwise it builds
``generic/platform=iOS Simulator``. Concurrent builds of this checkout are
serialized, since one DerivedData cannot serve two xcodebuild runs. The xcodebuild
log is kept at ``.artifacts/ui-build/build.log``; delete caches with
``pnpm verify:clean``.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / 'apps/ios/Lody.xcodeproj'
SCHEME = 'Lody'
SDK = 'iphonesimulator'
ARTIFACTS = ROOT / '.artifacts'
DEFAULT_LOG = ARTIFACTS / 'ui-build' / 'build.log'
GENERIC_DESTINATION = 'generic/platform=iOS Simulator'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--sdk', default=SDK, choices=['iphonesimulator', 'watchsimulator'])
parser.add_argument('--scheme', default=SCHEME, help='App scheme (default Lody)')
parser.add_argument('--configuration', default='Debug', help='Build configuration (default Debug)')
parser.add_argument(
    '--destination',
    default=None,
    help='xcodebuild destination; defaults to the LODY_VERIFY_UDID lease, else generic Simulator',
)
parser.add_argument(
    '--derived-data',
    default=None,
    help='Explicit build cache. Omit to reuse the project DerivedData; use only to compare two builds',
)
parser.add_argument('--skip-assets', action='store_true', help='Skip pnpm native:assets')
parser.add_argument('--log', default=str(DEFAULT_LOG), help=f'xcodebuild log path (default {DEFAULT_LOG})')
parser.add_argument('--json', action='store_true', help='Print one JSON object instead of the app path')


def progress(message):
    print(message, file=sys.stderr)


def destination(explicit, sdk=SDK):
    if explicit:
        return explicit
    udid = os.environ.get('LODY_VERIFY_UDID')
    if udid:
        return f'id={udid}'
    if sdk == 'watchsimulator':
        return 'generic/platform=watchOS Simulator'
    return GENERIC_DESTINATION


def xcodebuild(arguments):
    command = [
        'xcodebuild',
        '-project',
        str(PROJECT),
        '-scheme',
        arguments.scheme,
        '-configuration',
        arguments.configuration,
        '-sdk',
        arguments.sdk,
        '-destination',
        arguments.destination,
    ]
    if arguments.destination.startswith('id='):
        command += ['ONLY_ACTIVE_ARCH=YES']
    if arguments.derived_data is not None:
        command += ['-derivedDataPath', str(arguments.derived_data)]
    return command


def resolve_product(command):
    """Return (app path, build cache root) for the given xcodebuild invocation."""
    result = subprocess.run(
        [*command, '-showBuildSettings', '-json'], cwd=ROOT, capture_output=True, text=True
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or f'xcodebuild -showBuildSettings exited {result.returncode}')
    settings = json.loads(result.stdout)[0]['buildSettings']
    app = Path(settings['TARGET_BUILD_DIR']) / settings['FULL_PRODUCT_NAME']
    return app, Path(settings['BUILD_DIR']).parent


def generate_assets():
    progress('native assets')
    result = subprocess.run(
        ['pnpm', '--filter', '@lody-ios/ios', 'native:assets'], cwd=ROOT, capture_output=True, text=True
    )
    if result.returncode != 0:
        raise SystemExit(result.stdout + result.stderr)


def run_build(command, log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        [*command, 'build'], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    with log_path.open('w') as log:
        for line in process.stdout:
            log.write(line)
            print(line, end='', file=sys.stderr)
    process.stdout.close()
    return process.wait()


@contextmanager
def build_lock():
    """Serialize builds: one shared DerivedData cannot serve two xcodebuild runs."""
    lock_path = ARTIFACTS / 'verify-build.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('w') as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            progress('waiting for another build of this checkout')
            fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def main(argv=None):
    arguments = parser.parse_args(argv)
    arguments.destination = destination(arguments.destination, arguments.sdk)
    if arguments.derived_data is not None:
        arguments.derived_data = (ROOT / arguments.derived_data).resolve()
        if ARTIFACTS in arguments.derived_data.parents:
            parser.error('--derived-data must stay outside .artifacts')
    if not PROJECT.exists():
        raise SystemExit(f'{PROJECT} is missing; run pnpm prebuild first')
    log_path = (ROOT / arguments.log).resolve()
    command = xcodebuild(arguments)
    app, cache = resolve_product(command)
    progress(f'derived data  {cache}')
    with build_lock():
        if not arguments.skip_assets:
            generate_assets()
        progress(f'xcodebuild    {arguments.configuration} {arguments.destination}')
        if run_build(command, log_path) != 0:
            raise SystemExit(f'build failed; see {log_path}')
    if not app.exists():
        raise SystemExit(f'{app} was not produced; see {log_path}')
    progress(f'log           {log_path}')
    if arguments.json:
        print(
            json.dumps(
                {
                    'app': str(app),
                    'derivedData': str(cache),
                    'log': str(log_path),
                    'configuration': arguments.configuration,
                    'destination': arguments.destination,
                }
            )
        )
    else:
        print(app)
    return 0


if __name__ == '__main__':
    sys.exit(main())
