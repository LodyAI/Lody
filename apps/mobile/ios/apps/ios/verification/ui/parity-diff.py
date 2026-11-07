"""Compare two create-parity captures: parity-diff.py BASELINE_DIR CANDIDATE_DIR."""
import argparse
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline', type=Path)
parser.add_argument('candidate', type=Path)
parser.add_argument('--fuzz', default='3%')
parser.add_argument('--max-ratio', type=float, default=0.004)
# The expanded sheet below the status bar.
parser.add_argument('--crop', default='1206x2360+0+200')
args = parser.parse_args()

shots = sorted(p for p in args.baseline.rglob('*.png') if p.stem not in ('before', 'after'))
if not shots:
    sys.exit(f'No baseline captures under {args.baseline}')
failed = []
for base in shots:
    relative = base.relative_to(args.baseline)
    candidate = args.candidate / relative
    if not candidate.exists():
        failed.append(f'{relative}: missing')
        continue
    diff = args.candidate / 'parity-diff' / relative
    diff.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(['magick', 'compare', '-metric', 'AE', '-fuzz', args.fuzz, f'{base}[{args.crop}]', f'{candidate}[{args.crop}]', str(diff)], capture_output=True, text=True)
    if result.returncode > 1:
        failed.append(f'{relative}: {result.stderr.strip()}')
        continue
    pixels = float(result.stderr.split()[0])
    width, height = args.crop.split('+')[0].split('x')
    ratio = pixels / (int(width) * int(height))
    status = 'ok' if ratio <= args.max_ratio else 'DIFF'
    print(f'{status:4} {ratio:.5f} {relative}')
    if status != 'ok':
        failed.append(f'{relative}: {ratio:.5f}')
if failed:
    sys.exit('Parity failed:\n' + '\n'.join(failed))
print('PASS: all captures within parity threshold')
