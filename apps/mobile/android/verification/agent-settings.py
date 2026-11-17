#!/usr/bin/env python3
"""Synthetic production Settings UI acceptance; explicitly target a disposable emulator."""
import os, re, subprocess, time, xml.etree.ElementTree as ET
from pathlib import Path

ADB = os.environ.get('ADB', str(Path.home() / 'Library/Android/sdk/platform-tools/adb'))
SERIAL = os.environ['ANDROID_SERIAL']
OUT = Path(__file__).resolve().parent / 'evidence/agent-settings'
OUT.mkdir(parents=True, exist_ok=True)

def adb(*args):
    return subprocess.check_output([ADB, '-s', SERIAL, *args])

def dump():
    for _ in range(5):
        output = adb('shell', 'uiautomator', 'dump', '/sdcard/lody-settings.xml')
        if b'dumped to' in output:
            return ET.fromstring(adb('shell', 'cat', '/sdcard/lody-settings.xml'))
    raise AssertionError('Accessibility root unavailable')

def nodes(label):
    return [n for n in dump().iter('node') if n.get('text') == label or n.get('content-desc') == label]

def wait(label):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        found = nodes(label)
        if found: return found[0]
    raise AssertionError('Missing UI: ' + label)

def tap(label):
    n = wait(label)
    x1,y1,x2,y2 = map(int, re.findall(r'\d+', n.get('bounds')))
    adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))

def scroll_to(label):
    for _ in range(8):
        found = nodes(label)
        if found: return
        tree = dump()
        area = next((n for n in tree.iter('node') if n.get('scrollable') == 'true'), None)
        assert area is not None, 'No scroll area for ' + label
        x1,y1,x2,y2 = map(int, re.findall(r'\d+', area.get('bounds')))
        adb('shell', 'input', 'swipe', str((x1+x2)//2), str(y2-150), str((x1+x2)//2), str(y1+150), '250')
    raise AssertionError('Missing scrolled UI: ' + label)

def shot(name):
    (OUT / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p'))

def select(current, target):
    tap(current); tap(target); wait(target)

def disabled(label):
    tree = dump()
    def walk(n, enabled=True):
        enabled = enabled and n.get('enabled', 'true') == 'true'
        if n.get('text') == label or n.get('content-desc') == label:
            assert not enabled, label + ' should be disabled'
            return True
        return any(walk(c, enabled) for c in n)
    assert walk(tree), label + ' missing'

adb('shell', 'am', 'start', '-S', '-n', 'ai.lody.android/app.lody.android.diagnostics.AgentSettingsProbeActivity')
wait('Studio computer'); wait('Codex'); shot('agent-list')
tap('Back'); wait('Alex Example')
assert not nodes('Machines'), 'Machine destination must not appear in Settings'
shot('settings-home')
tap('Agents'); wait('Studio computer')
tap('Studio computer'); wait('Empty computer'); shot('machine-picker'); tap('Empty computer')
wait('Add provider'); shot('empty-machine')
tap('Add provider'); wait('Save'); shot('create-provider')
tap('Name'); adb('shell', 'input', 'text', 'Fixture-created'); tap('Save'); wait('Fixture-created')
shot('created-provider')
select('Empty computer', 'Second computer'); wait('Other machine assistant'); shot('other-machine-retained')
select('Second computer', 'Shared computer'); disabled('Add provider'); tap('Shared assistant'); wait('Edit'); disabled('Save'); shot('read-only'); tap('Back')
select('Shared computer', 'Offline computer'); disabled('Add provider'); shot('offline')
select('Offline computer', 'Studio computer'); tap('Codex'); wait('Edit'); shot('provider-editor')
scroll_to('Sign in'); tap('Sign in'); wait('Fixture sign in'); scroll_to('Continue'); tap('Continue'); wait('Example key'); tap('Example key'); adb('shell', 'input', 'text', 'synthetic-key'); adb('shell', 'input', 'keyevent', '4')
scroll_to('Continue'); tap('Continue'); wait('Signed in'); shot('synthetic-authentication')
scroll_to('Runtime status'); tap('Runtime status'); wait('Runtime installed'); shot('runtime-status')
scroll_to('Keep stored value'); shot('write-only-environment'); tap('Back'); tap('Pi'); wait('Edit'); scroll_to('Scan Pi extensions'); tap('Scan Pi extensions'); wait('Fixture extension'); shot('pi-extension-scan')
print('PASS: Settings without Machines; picker; empty-machine create; other-machine retention; readonly/offline gates; synthetic auth; runtime status; write-only env; Pi scan.')
print(OUT)
