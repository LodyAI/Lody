"""Queue above the composer; Steer delivers the selected item, Stop advances FIFO."""
import json
import sys
from driver import UI
import catalog
from send_motion import ThrowTrace

ui = UI(*sys.argv[1:])
trace = ThrowTrace(ui)
ui.axe('tap', '--id', 'send-connect')
assert ui.element('session-stop')['enabled'], 'Running with no draft must offer Stop'
assert ui.element('session-stop')['AXLabel'] == catalog.text('native.chat.composer.stop')
ui.axe('tap', '--id', 'session-input', '--post-delay', '.6')
ui.type_into('session-input', 'draft')
assert ui.element('session-send')['enabled']
for _ in range(5):
    ui.axe('tap', '--id', 'delete', '--post-delay', '.1')
assert ui.element('session-stop')['enabled'], 'Deleting the draft must restore Stop'
turns = []
for index in [1, 2]:
    message = f'{index} message'
    ui.type_into('session-input', message)
    ui.axe('tap', '--id', 'session-send')
    ui.wait(lambda items: any(i.get('AXLabel') == f'Calls: {index} · sending' for i in items), 'Queue write did not start')
    pending = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':queued') and message in (i.get('AXLabel') or '')), None), 'Pending queue card missing')
    turn = pending['AXUniqueId'].removesuffix(':queued')
    turns.append(turn)
    assert not any(i.get('AXUniqueId') in [turn + ':user', turn + ':duration'] for i in ui.state()), 'Queued message flashed in the transcript'
    assert not ui.element(turn + ':steer')['enabled'], 'Unconfirmed queue write must not be steerable'
    assert ui.element(turn + ':steer')['AXLabel'].startswith(catalog.text('native.chat.composer.steer') + ': ')
    ui.axe('tap', '--id', 'send-complete', '--post-delay', '1')
    ui.wait(lambda items: any(i.get('AXUniqueId') == turn + ':steer' and i.get('enabled') for i in items), 'Queue receipt did not unlock Steer')
    assert ui.element('queue-count')['AXLabel'] == f'Queue: {index}'
    assert not ui.element('session-input').get('AXValue'), 'Queued draft reappeared'
    assert ui.element('session-stop')['enabled']
    frame = ui.element(turn + ':queued')['frame']
    assert frame['y'] + frame['height'] <= ui.element('session-input')['frame']['y'], 'Queue must sit above the input'
    ui.capture(f'queued-{index}')
ui.axe('tap', '--id', 'send-toggle-context', '--post-delay', '.8')
queue = ui.element('session-queue')['frame']
context = ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == 'session-preview' and i['frame']['height'] > 0), None), 'Context chip missing')['frame']
assert queue['y'] - context['y'] - context['height'] >= 6, f'Queue must not touch the chip row: {queue} {context}'
field = ui.element('session-input')['frame']
assert queue['x'] >= field['x'] and queue['x'] + queue['width'] <= field['x'] + field['width'], 'Queue must stay within the composer width'
ui.capture('queued-context-chip')
ui.axe('tap', '--id', 'send-toggle-context', '--post-delay', '.8')
queue = ui.element('session-queue')['frame']
field = ui.element('session-input')['frame']
assert queue['x'] >= field['x'] and queue['x'] + queue['width'] <= field['x'] + field['width'], 'Queue must stay within the composer width'
assert turns[0] != turns[1]
assert not set(trace.folder.glob('lody-throw-*.json')) - trace.existing, 'Queuing a message must not fly it into the transcript'
ui.type_into('session-input', '123456')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'inputView' and i['frame']['height'] > 200 for i in items),
        'Queue landing must be exercised with the software keyboard open')

ui.axe('tap', '--id', turns[1] + ':steer', '--post-delay', '1')
request = json.loads(ui.element('control-request')['AXLabel'])
assert request['action'] == 'steer' and request['messageId'] == turns[1] and request['turnId'] == 'running-reply'
ui.axe('tap', '-x', '5', '-y', str(ui.element('chat-transcript')['frame']['y'] + 10), '--post-delay', '.6')
ui.wait(lambda items: any(i.get('AXUniqueId') == turns[1] + ':delivery' for i in items), 'Steer confirmation did not stay in the transcript')
assert not any(i.get('AXUniqueId') == turns[1] + ':queued' for i in ui.state())
delivery = ui.element(turns[1] + ':delivery')['frame']
bubble = ui.element(turns[1] + ':user')['frame']
assert delivery['y'] + delivery['height'] <= bubble['y'] + 1, 'Steer status must stay above its user bubble'
ui.capture('steer-pending')
ui.wait(lambda _: trace.reserved_space() is not None, 'Steer landing geometry missing')
assert abs(trace.reserved_space()) < 1, 'Steering a queued message must not reserve a new turn viewport'
ui.element('running-reply:text')
ui.axe('tap', '--id', 'send-fail')
ui.wait(lambda items: any(i.get('AXUniqueId') == turns[1] + ':delivery' and i.get('AXLabel') == catalog.text('native.chat.message.guide.unknown') for i in items), 'Lost ACK did not retain an unconfirmed history bubble')
assert ui.element('queue-count')['AXLabel'] == 'Queue: 1'
ui.capture('steer-unconfirmed-retained')
# Late history acceptance settles the same message without another Steer request.
ui.axe('tap', '--id', 'send-complete', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'queue-count' and i.get('AXLabel') == 'Queue: 1' for i in items), 'Selected Steer was not consumed')
ui.element(turns[0] + ':queued')
assert not any(i.get('AXUniqueId') == turns[1] + ':queued' for i in ui.state())
ui.wait(lambda items: not any(i.get('AXUniqueId') == turns[1] + ':delivery' for i in items), 'Accepted steer status did not disappear')
ui.element(turns[1] + ':reply:text')
if not any(i.get('AXUniqueId') == turns[1] + ':user' for i in ui.state()):
    ui.axe('swipe', '--start-x', '200', '--start-y', '350', '--end-x', '200', '--end-y', '700', '--duration', '.4', '--post-delay', '.6')
ui.element(turns[1] + ':user')
assert ui.element('session-input').get('AXValue') == '123456', 'Steer must preserve the current unsent draft'
ui.capture('steer-applied-first-still-queued')
ui.axe('tap', '--id', 'session-input', '--post-delay', '.6')
for _ in range(6):
    ui.axe('tap', '--id', 'delete', '--post-delay', '.1')

ui.axe('tap', '--id', 'session-stop')
request = json.loads(ui.element('control-request')['AXLabel'])
assert request['action'] == 'stop' and request['turnId'] == turns[1] + ':reply'
assert not ui.element('session-stop')['enabled']
ui.capture('stopping')
ui.axe('tap', '--id', 'send-complete', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'queue-count' and i.get('AXLabel') == 'Queue: 0' for i in items), 'Stop did not advance the queued message')
ui.element(turns[0] + ':reply:text')
if not any(i.get('AXUniqueId') == turns[0] + ':user' for i in ui.state()):
    ui.axe('swipe', '--start-x', '200', '--start-y', '350', '--end-x', '200', '--end-y', '700', '--duration', '.4', '--post-delay', '.6')
ui.element(turns[0] + ':user')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'session-stop' and i.get('enabled') for i in items), 'The next running turn must offer Stop')
ui.capture('stop-advanced-queue')
ui.axe('tap', '--id', 'session-stop')
ui.axe('tap', '--id', 'send-complete', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'session-send' and not i.get('enabled') for i in items), 'Stop without a queue must return to idle')
assert not any((i.get('AXUniqueId') or '').endswith(':queued') for i in ui.state())
assert not any(i.get('AXUniqueId') == 'session-queue' and i['frame']['height'] > 0 for i in ui.state()), \
    'Empty queue glass must release its reserved height'
ui.capture('idle')
trace.verify(1)
print('PASS: input/Stop switching, queue-only pending cards, selected Steer with lost ACK and late acceptance, targeted Stop advances FIFO, no queue-time throw, steered rows slide into the transcript')
