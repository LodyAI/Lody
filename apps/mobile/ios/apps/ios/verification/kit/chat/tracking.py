"""Native preview check: python3 tracking.py SIMULATOR_UDID [evidence-directory]."""
import json
import subprocess
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ui'))
import catalog

udid = sys.argv[1]

def axe(*args):
    return subprocess.check_output(['axe', *args, '--udid', udid], text=True)

def cells(node):
    if isinstance(node, dict):
        if (node.get('AXUniqueId') or '').startswith(('history-', 'preview:')):
            yield node
        for value in node.values():
            yield from cells(value)
    elif isinstance(node, list):
        for value in node:
            yield from cells(value)

def snapshot():
    return {item['AXUniqueId']: item for item in cells(json.loads(axe('describe-ui')))}

def screenshot(name):
    if len(sys.argv) > 2:
        subprocess.run(['xcrun', 'simctl', 'io', udid, 'screenshot', sys.argv[2] + '/' + name + '.png'], check=True)

assert 'chat-navigation-title' in axe('describe-ui'), 'Open the native chat preview first'
axe('tap', '--label', 'Retry')
time.sleep(4)
axe('swipe', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '700', '--duration', '1')
time.sleep(2)
before = snapshot()
screenshot('tracking-released')
time.sleep(1.2)
after = snapshot()
common = [key for key in before.keys() & after.keys() if key.startswith('history-')]
assert common, 'No stable history row visible while tracking is released'
drift = max(abs(before[key]['frame']['y'] - after[key]['frame']['y']) for key in common)
assert drift <= 1, ('New streamed text pulled the reader out of history', drift)
assert 'chat-scroll-to-bottom' in axe('describe-ui'), 'History must offer a return-to-bottom button'
axe('tap', '--label', catalog.text('native.chat.scrollToBottom'))
time.sleep(2)
assert 'preview:answer' in snapshot(), 'Returning to the tail must reveal the conclusion'
screenshot('tracking-resumed')
print(json.dumps({'historyDrift': drift, 'returnedToTail': True}))

axe('tap', '--label', 'Fast Replay')
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    current = snapshot()
    completed = current.get('preview:answer', {})
    if '分割线之后的收尾段落' in completed.get('AXLabel', ''):
        break
    time.sleep(.2)
else:
    raise AssertionError('Fast replay did not finish')
assert '清晰可读' in completed['AXLabel'], 'Fast output must finish visibly'
screenshot('fast-completed')
axe('swipe', '--start-x', '200', '--start-y', '400', '--end-x', '200', '--end-y', '460', '--duration', '0.8')
time.sleep(1.2)
before = snapshot()['preview:answer']['frame']['y']
time.sleep(1)
after = snapshot()['preview:answer']['frame']['y']
assert abs(after - before) <= 1, 'Completed tracking must not pull the viewport back'
screenshot('completed-free-scroll')
print(json.dumps({'fastOutputComplete': True, 'completedScrollDrift': abs(after - before)}))

axe('swipe', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '700', '--duration', '1')
time.sleep(1)
assert 'chat-scroll-to-bottom' in axe('describe-ui'), 'Completed history must also offer return to bottom'
screenshot('completed-button')
axe('tap', '--label', catalog.text('native.chat.scrollToBottom'))
time.sleep(1)
assert 'preview:answer' in snapshot(), 'The button must return to the completed conclusion'
assert 'chat-scroll-to-bottom' not in axe('describe-ui'), 'The button must disappear at the bottom'
screenshot('button-returned')
print(json.dumps({'returnButtonDuringStreamAndAfterCompletion': True}))

axe('tap', '--label', 'Retry')
time.sleep(2)
axe('swipe', '--start-x', '200', '--start-y', '400', '--end-x', '200', '--end-y', '425', '--duration', '0.8', '--delta', '2')
time.sleep(0.3)
before = snapshot()
screenshot('small-drag-released')
time.sleep(1)
after = snapshot()
common = [key for key in before.keys() & after.keys() if key.startswith('history-') or key == 'preview:intro']
assert common, 'A stable row must remain visible after a small upward drag'
small_drift = max(abs(before[key]['frame']['y'] - after[key]['frame']['y']) for key in common)
assert small_drift <= 1, ('Small upward drag was pulled back by tracking', small_drift)
screenshot('small-drag-still')
print(json.dumps({'smallDragDrift': small_drift}))
