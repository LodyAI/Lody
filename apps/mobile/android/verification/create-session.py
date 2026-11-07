#!/usr/bin/env python3
"""Production creation UI with an offline service; never sends a cloud task."""
import os, re, subprocess, sys, time, xml.etree.ElementTree as E
from pathlib import Path
adb = str(Path(os.environ.get('ANDROID_HOME', str(Path.home() / 'Library/Android/sdk'))) / 'platform-tools/adb')
serial = sys.argv[1] if len(sys.argv) > 1 else 'emulator-5554'
evidence = Path(__file__).parent / 'evidence/create'
evidence.mkdir(parents=True, exist_ok=True)
def run(*args): return subprocess.check_output([adb, '-s', serial, *args])
def nodes():
    run('shell', 'uiautomator', 'dump', '/sdcard/create-check.xml')
    return list(E.fromstring(run('exec-out', 'cat', '/sdcard/create-check.xml')).iter('node'))
def find(label, enabled=None):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        for n in nodes():
            if label in [n.get('text'), n.get('content-desc')] and (enabled is None or n.get('enabled') == str(enabled).lower()): return n
    raise AssertionError('Missing: ' + label)
def tap(n):
    x1,y1,x2,y2 = map(int,re.findall(r'\d+',n.get('bounds')))
    run('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
def screenshot(name): (evidence / name).write_bytes(run('exec-out','screencap','-p'))
def start(result):
    run('shell','am','start','-S','-W','-n','ai.lody.android/app.lody.android.diagnostics.CreateSessionProbeActivity','--es','result',result)
    find('Fixture assistant')
for result in ['accepted', 'unknown']:
    start(result)
    if result == 'accepted':
        tap(find('Fixture assistant'));tap(find('Fixture model'));tap(find('high'))
        screenshot('config.png');run('shell','input','keyevent','4')
    tap(find('Describe what you want to do…'))
    run('shell','input','text','Android%stest%screation');run('shell','input','keyevent','4')
    screenshot('ready.png')
    tap(find('Send', True))
    if result == 'accepted': find('Created: Android test creation')
    else:
        find('Delivery is unconfirmed. Check the conversation before starting another one.')
        find('Send', False)
        screenshot('unknown-result.png')
        tap(find('Open conversation'));find('Created: Android test creation')
    screenshot(result + '.png')
print('PASS: configuration selection, create callback, unknown result and replay prevention')
