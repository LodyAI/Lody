"""Agent without acknowledged steer: Steer cancels the running turn and the queue advances FIFO."""
import json
import sys
from driver import UI

ui = UI(*sys.argv[1:])
ui.axe('tap', '--id', 'send-connect')
ui.axe('tap', '--id', 'session-input')
turns = []
for index in [1, 2]:
    ui.type_into('session-input', f'{index} queued message')
    ui.axe('tap', '--id', 'session-send')
    pending = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':queued') and f'{index} queued message' in (i.get('AXLabel') or '')), None), 'Pending queue card missing')
    turns.append(pending['AXUniqueId'].removesuffix(':queued'))
    ui.axe('tap', '--id', 'send-complete')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'queue-count' and i.get('AXLabel') == f'Queue: {index}' for i in items), 'Queue receipt missing')
ui.wait(lambda items: any(i.get('AXUniqueId') == turns[0] + ':steer' and i.get('enabled') for i in items), 'First queued message must offer Steer')
assert not ui.element(turns[1] + ':steer')['enabled'], 'Interrupt fallback must only offer the first queued message'
ui.capture('interrupt-first-only')

ui.axe('tap', '--id', turns[0] + ':steer')
request = json.loads(ui.element('control-request')['AXLabel'])
assert request['action'] == 'steer' and request['interrupt'] is True and request['messageId'] == turns[0] and request['turnId'] == 'running-reply', request
assert not ui.element('session-stop')['enabled']
ui.capture('interrupting')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'queue-count' and i.get('AXLabel') == 'Queue: 1' for i in items), 'Interrupt did not advance the queue')
ui.element(turns[0] + ':reply:text')
if not any(i.get('AXUniqueId') == turns[0] + ':user' for i in ui.state()):
    ui.axe('swipe', '--start-x', '200', '--start-y', '350', '--end-x', '200', '--end-y', '700', '--duration', '.4', '--post-delay', '.6')
ui.element(turns[0] + ':user')
ui.element(turns[1] + ':queued')
ui.wait(lambda items: any(i.get('AXUniqueId') == turns[1] + ':steer' and i.get('enabled') for i in items), 'The next queued message must offer Steer')
ui.capture('interrupt-advanced-first')
print('PASS: without acknowledged steer only the first queued message is steerable, Steer interrupts the running turn, and the queue advances FIFO')
