#!/usr/bin/env python3
"""Reclaim verification scratch left in the temp directory.

Verification builds share one Xcode DerivedData (`pnpm verify:build`), so an
ad-hoc build cache or a copied checkout under the temp directory is leftover
scratch that nothing collects: a per-task ``-derivedDataPath`` costs 1-3 GB and a
copied tree costs more. This lists those entries and their sizes; ``--apply``
deletes them.

    pnpm verify:clean                       # what would be removed
    pnpm verify:clean --apply               # remove scratch older than 12h
    pnpm verify:clean --apply --older-than 0  # remove everything reported
"""
import argparse
import os
from pathlib import Path
import shutil
import sys
import time

DERIVED_DATA_MARKERS = ('ModuleCache.noindex', 'SDKStatCaches.noindex')
PROJECT_PREFIXES = ('lody-',)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', action='append', default=None, help='Temp root to scan; repeatable')
parser.add_argument(
    '--older-than',
    type=float,
    default=12.0,
    metavar='HOURS',
    help='Skip entries modified more recently than this (default 12)',
)
parser.add_argument('--apply', action='store_true', help='Delete the reported entries')
parser.add_argument('--min-size', type=float, default=0.0, metavar='MB', help='Skip entries smaller than this')


def default_roots():
    roots = [Path('/tmp')]
    tmpdir = os.environ.get('TMPDIR')
    if tmpdir:
        roots.append(Path(tmpdir))
    unique = []
    for root in roots:
        resolved = root.resolve()
        if resolved.is_dir() and resolved not in unique:
            unique.append(resolved)
    return unique


def is_scratch(path):
    """True only for an Xcode build cache or a staged copy of this checkout."""
    if path.is_symlink() or not path.is_dir():
        return False
    if (path / 'Build' / 'Products').is_dir():
        return True
    if all((path / marker).is_dir() for marker in DERIVED_DATA_MARKERS):
        return True
    return path.name.startswith(PROJECT_PREFIXES) and (path / 'apps/ios').is_dir()


def directory_size(path):
    total = 0
    for entry in path.rglob('*'):
        try:
            if entry.is_file() and not entry.is_symlink():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def human_size(size):
    if size >= 1024**3:
        return f'{size / 1024**3:6.2f} GB'
    return f'{size / 1024**2:6.1f} MB'


def collect(roots, older_than_hours, minimum_bytes):
    cutoff = time.time() - older_than_hours * 3600
    found = []
    for root in roots:
        for entry in sorted(root.iterdir()):
            try:
                if not is_scratch(entry) or entry.stat().st_mtime > cutoff:
                    continue
                size = directory_size(entry)
            except OSError:
                continue
            if size >= minimum_bytes:
                found.append((entry, size, entry.stat().st_mtime))
    return found


def main(argv=None):
    arguments = parser.parse_args(argv)
    roots = [Path(root).expanduser().resolve() for root in arguments.root] if arguments.root else default_roots()
    if not roots:
        raise SystemExit('no temp root to scan')
    found = collect(roots, arguments.older_than, arguments.min_size * 1024 * 1024)
    if not found:
        print(f'no verification scratch under {", ".join(str(root) for root in roots)}')
        return 0
    found.sort(key=lambda entry: entry[1], reverse=True)
    total = sum(size for _, size, _ in found)
    verb = 'Removing' if arguments.apply else 'Would remove'
    print(f'{verb} {len(found)} entries, {total / 1024**3:.2f} GB:')
    for path, size, modified in found:
        age = (time.time() - modified) / 3600
        print(f'  {human_size(size)}  {age:5.1f}h  {path}')
    if not arguments.apply:
        print('Pass --apply to delete these entries.')
        return 0
    released = 0
    for path, size, _ in found:
        try:
            shutil.rmtree(path)
        except OSError as error:
            print(f'failed to remove {path}: {error}', file=sys.stderr)
            continue
        released += size
    print(f'released {released / 1024**3:.2f} GB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
