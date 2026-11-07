#!/usr/bin/env python3
"""Offline debug acceptance on a caller-owned emulator. Requires installed debug APK."""
import json, os, re, subprocess, time, xml.etree.ElementTree as ET
from pathlib import Path

ADB = os.environ.get('ADB', str(Path.home() / 'Library/Android/sdk/platform-tools/adb'))
SERIAL = os.environ.get('ANDROID_SERIAL', 'emulator-5554')
OUT = Path(__file__).resolve().parent / 'evidence/phase-1'
OUT.mkdir(parents=True, exist_ok=True)
BASE = [ADB, '-s', SERIAL]

def adb(*args):
    return subprocess.check_output(BASE + list(args))

def dump():
    for attempt in range(5):
        adb('shell','rm','-f','/sdcard/lody-phase1.xml')
        output = adb('shell', 'uiautomator', 'dump', '/sdcard/lody-phase1.xml')
        if b'dumped to' in output:
            return ET.fromstring(adb('shell', 'cat', '/sdcard/lody-phase1.xml'))
        time.sleep(.2)  # Accessibility roots can be absent during Activity transitions.
    raise AssertionError('No accessibility hierarchy after Activity transition')

def texts(tree):
    return '\n'.join(n.get('text', '') for n in tree.iter('node'))

def wait_text(value, timeout=35):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        tree = dump()
        if value in texts(tree): return tree
        time.sleep(.2)
    raise AssertionError(f'UI did not show {value}')

def click(label):
    for attempt in range(4):
        tree = dump()
        for node in tree.iter('node'):
            if node.get('text') == label:
                x1,y1,x2,y2 = map(int, re.findall(r'\d+', node.get('bounds')))
                adb('shell','input','tap',str((x1+x2)//2),str((y1+y2)//2))
                return
        scroll = next((n for n in tree.iter('node') if n.get('scrollable') == 'true'),None)
        if scroll is None: break
        x1,y1,x2,y2 = map(int,re.findall(r'\d+',scroll.get('bounds')))
        adb('shell','input','swipe',str((x1+x2)//2),str(y2-100),str((x1+x2)//2),str(y1+100),'300')
    raise AssertionError(f'UI control missing: {label}')

def screenshot(name):
    (OUT / name).write_bytes(adb('exec-out','screencap','-p'))

def launch():
    adb('shell','am','start','-n','ai.lody.android/app.lody.android.diagnostics.RuntimeProbeActivity')

adb('shell','am','force-stop','ai.lody.android')
launch()
wait_text('7/7 checks passed')
initial_pid=adb('shell','pidof','ai.lody.android').decode().strip()
screenshot('checks.png')
initial_generation = re.search(r'Generation (\d+)', texts(dump())).group(1)
adb('shell','input','keyevent','KEYCODE_HOME')
time.sleep(9)  # Intentionally cross the native eight-second heartbeat deadline.
launch()
resumed = wait_text('7/7 checks passed')
assert re.search(r'Generation (\d+)',texts(resumed)).group(1) == initial_generation
assert adb('shell','pidof','ai.lody.android').decode().strip() == initial_pid
recording=subprocess.Popen(BASE+['shell','screenrecord','--bit-rate','1000000','--time-limit','40','/sdcard/lody-phase1.mp4'],stdout=subprocess.DEVNULL)
click('Open runtime details')
wait_text('This page shares the application-owned runtime.')
screenshot('details.png')
click('Back to checks')
click('Switch offline workspace')
# The controls are below the status; return the scroll position to the top.
adb('shell','input','swipe','540','400','540','2000','300')
wait_text('Scope: workspace-b')
wait_text('7/7 checks passed')
screenshot('workspace-b.png')
# A process restart discards the debug scope; the new process only activates its fixed offline fixture.
adb('shell','am','force-stop','ai.lody.android')
launch()
wait_text('Scope: workspace-a')
wait_text('7/7 checks passed')
new_pid=adb('shell','pidof','ai.lody.android').decode().strip()
assert initial_pid != new_pid
screenshot('fresh-process.png')
recording.wait(timeout=50)
adb('pull','/sdcard/lody-phase1.mp4',str(OUT/'navigation-process.mp4'))
result={'initialPid':initial_pid,'restartedPid':new_pid,'background':'9 seconds via Home; same PID and generation','navigation':'details and back','workspaceSwitch':'workspace-a → workspace-b','processRestart':'fresh workspace-a fixture; no persisted commands','offlineChecks':'7/7','video':'navigation-process.mp4'}
(OUT/'process-check.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
