"""Measure an idle foreground list with visible running marks; no taps during sampling.

Usage: python3 working-grid-performance.py [--max-fps 30]
This measures rendered frames, not recompositions. Keep the same device, graphics
backend and visible rows for before/after comparisons. Run without screen recording, which adds encoder overhead.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--max-fps', type=float, default=30)
parser.add_argument('--seconds', type=float, default=10)
args = parser.parse_args()
adb = shutil.which('adb') or str(Path(os.environ.get('ANDROID_HOME', Path.home() / 'Library/Android/sdk')) / 'platform-tools/adb')

def graphics():
    return subprocess.check_output([adb, 'shell', 'dumpsys', 'gfxinfo', 'ai.lody.android'], text=True)

before = int(re.search(r'Total frames rendered: (\d+)', graphics())[1])
started = time.monotonic()
time.sleep(args.seconds)
after = int(re.search(r'Total frames rendered: (\d+)', graphics())[1])
elapsed = time.monotonic() - started
fps = (after - before) / elapsed
print(json.dumps({'seconds': round(elapsed, 2), 'frames': after - before, 'fps': round(fps, 2)}))
assert 0 < fps <= args.max_fps, f'Expected visible animation within {args.max_fps} fps budget, got {fps:.1f}'
