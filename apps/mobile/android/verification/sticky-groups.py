"""Run against an installed debug APK: python3 verification/sticky-groups.py [serial]."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

ADB = shutil.which('adb') or str(Path(os.environ.get('ANDROID_HOME', Path.home() / 'Library/Android/sdk')) / 'platform-tools/adb')
serial = sys.argv[1] if len(sys.argv) > 1 else 'emulator-5554'
def adb(*args):
    return subprocess.check_output([ADB, '-s', serial, *args], text=True)
def nodes():
    adb('shell', 'uiautomator', 'dump', '/sdcard/lody-sticky.xml')
    return list(ET.fromstring(adb('exec-out', 'cat', '/sdcard/lody-sticky.xml')).iter('node'))
def label(title):
    found = [n for n in nodes() if n.get('text') == title]
    assert len(found) == 1, (title, len(found))
    return list(map(int, re.findall(r'\d+', found[0].get('bounds'))))
def launch(search=False):
    adb('shell', 'am', 'start', '-S', '-W', '-n',
        'ai.lody.android/app.lody.android.diagnostics.StickyGroupsProbeActivity', '--ez', 'search', str(search).lower())
def swipe(up=True):
    width, height = map(int, re.findall(r'(\d+)x(\d+)', adb('shell', 'wm', 'size'))[-1])
    x, high, low = str(width // 2), str(int(height * .35)), str(int(height * .65))
    adb('shell', 'input', 'swipe', x, low if up else high, x, high if up else low, '500')

launch()
start = label('Alpha project')[1]
swipe()
assert abs(label('Alpha project')[1] - start) < 5, 'First group must stay pinned and accessible'
for _ in range(8):
    swipe()
    hits = [n for n in nodes() if n.get('text') == 'Beta project']
    if hits and abs(int(re.findall(r'\d+', hits[0].get('bounds'))[1]) - start) < 5:
        break
else:
    raise AssertionError('Second group never reached the pinned slot')
label('Beta project')
for _ in range(8):
    swipe(False)
    hits = [n for n in nodes() if n.get('text') == 'Alpha project']
    if hits:
        label('Alpha project')
        break
else:
    raise AssertionError('First group did not return')
launch(True)
label('Alpha project')
swipe()
assert not any(n.get('text') == 'Alpha project' for n in nodes()), 'Search headers must scroll away'
print('PASS: single accessible sticky header, hand-off, reverse scroll, and non-sticky search')
