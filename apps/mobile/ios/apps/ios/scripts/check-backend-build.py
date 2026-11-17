"""Reject stale insecure or mismatched native/runtime build configuration."""
import json
import os
from pathlib import Path
import plistlib


def validate(info, configuration):
    values = info['LodyBackends']
    if any(not values[key].startswith('https://') for key in ['CONVEX_URL', 'CONVEX_SITE_URL', 'CF_WORKER_URL']):
        raise ValueError('Backends require HTTPS in every configuration. Regenerate using public TLS origins.')


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    info = plistlib.loads((root / '.generated/Lody/Info.plist').read_bytes())
    validate(info, os.environ.get('CONFIGURATION'))
    if info['LodyBackends'] != json.loads((root / '.generated/backend-config.json').read_text()):
        raise ValueError('Backend assets and native configuration differ. Run pnpm prebuild with the same environment.')
