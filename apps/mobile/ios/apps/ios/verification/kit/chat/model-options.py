"""Open Debug > 原生聊天预览, then run: python3 model-options.py UDID OUTPUT.
Exercises the real UIKit controls and native state update without sending a turn.
"""
import atexit
import json
import pathlib
import signal
import subprocess
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ui'))
import catalog

udid, output = sys.argv[1:]
out = pathlib.Path(output)
out.mkdir(parents=True, exist_ok=True)


def axe(*args):
    return subprocess.check_output(['axe', *args, '--udid', udid], text=True)


def flatten(items):
    for item in items:
        yield item
        yield from flatten(item.get('children', []))


def state():
    return list(flatten(json.loads(axe('describe-ui'))))


def element(identifier):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        found = next((i for i in state() if i.get('AXUniqueId') == identifier), None)
        if found:
            return found
        time.sleep(0.2)
    raise AssertionError(f'Control did not appear: {identifier}')


def shot(name):
    time.sleep(0.5)
    subprocess.run(['xcrun', 'simctl', 'io', udid, 'screenshot', str(out / (name + '.png'))], check=True, capture_output=True)
    (out / (name + '.json')).write_text(json.dumps(state(), ensure_ascii=False, indent=2))


def slide(fraction):
    frame = element('composer-effort-slider')['frame']
    axe('tap', '-x', str(frame['x'] + 16 + fraction * (frame['width'] - 32)), '-y', str(frame['y'] + frame['height'] / 2))


assert any(i.get('AXLabel', '').startswith('原生聊天预览,') for i in state() if i.get('AXLabel')), 'Use the Debug preview only'
axe('tap', '--id', 'session-input')
time.sleep(0.5)
assert not any(i.get('AXUniqueId') == 'session-effort' for i in state()), 'One combined entry expected'
shot('entry')
axe('tap', '--id', 'session-model')
recording = subprocess.Popen(['xcrun', 'simctl', 'io', udid, 'recordVideo', '--codec=hevc', str(out / 'ultra.mp4')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
atexit.register(lambda: recording.send_signal(signal.SIGINT) if recording.poll() is None else None)
slide(1)
assert 'Ultra' in element('composer-model-menu')['AXLabel']
shot('ultra')
time.sleep(1)
shot('ultra-flow')
frame = element('composer-effort-slider')['frame']
axe('swipe', '--start-x', str(frame['x'] + frame['width'] - 16), '--start-y', str(frame['y'] + 22), '--end-x', str(frame['x'] + 16), '--end-y', str(frame['y'] + 22), '--duration', '0.6')
assert catalog.text('native.chat.composer.defaultEffort') in element('composer-model-menu')['AXLabel']
time.sleep(1)
recording.send_signal(signal.SIGINT)
recording.wait(timeout=10)
slide(1 / 5)
assert 'Low' in element('composer-model-menu')['AXLabel']
axe('tap', '--id', 'composer-model-menu')
shot('models')
axe('tap', '--label', 'GPT-6 Astra', '--element-type', 'Button')
time.sleep(0.5)
assert catalog.text('native.chat.composer.modelPicker', model='GPT-6 Astra', effort=catalog.text('native.chat.composer.defaultEffort')) == element('composer-model-menu')['AXLabel'], 'Model switch must reset effort'
slide(2 / 5)
assert 'Medium' in element('composer-model-menu')['AXLabel']
shot('panel')
# Dismiss outside the popover, then confirm the native selection survives reopening.
axe('tap', '-x', '20', '-y', '160')
time.sleep(0.5)
assert 'GPT-6 Astra Medium' in element('session-model')['AXLabel']
axe('tap', '--id', 'session-model', '--post-delay', '0.5')
assert catalog.text('native.chat.composer.modelPicker', model='GPT-6 Astra', effort='Medium') == element('composer-model-menu')['AXLabel']
shot('reopened')
print('PASS: combined entry, effort endpoints, drag to default, model switch, native selection and reopen')
