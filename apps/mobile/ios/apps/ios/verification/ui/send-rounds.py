"""Three accepted turns in one production NativeChat, retaining conversation history."""
import sys
from driver import UI
import catalog
from send_motion import ThrowTrace

ui = UI(*sys.argv[1:])
trace = ThrowTrace(ui)
ui.axe('tap', '--id', 'send-connect')
messages = [
    '1 short',
    '2 a longer message that wraps across several lines and exercises the wide bubble animation while keeping previous conversation turns',
    '3 multiple lines\n4 the next line stays intact\n5 the final line',
]
turns = []
for index, message in enumerate(messages, 1):
    ui.axe('tap', '--id', 'session-input')
    ui.type_into('session-input', message)
    assert ui.element('session-input')['AXValue'] == message
    ui.capture(f'round-{index}-draft')
    # Keep delivery above long messages visible and leave measurable reply space.
    ui.axe('tap', '-x', '5', '-y', str(ui.element('chat-transcript')['frame']['y'] + 10), '--post-delay', '.6')
    ui.axe('tap', '--id', 'session-send')
    ui.wait(lambda items: any(i.get('AXLabel') == f'Calls: {index} · sending' for i in items), 'Turn did not dispatch')
    pending = ui.wait(lambda items: next((i for i in items
        if (i.get('AXUniqueId') or '').endswith(':delivery')
        and i['AXUniqueId'].removesuffix(':delivery') not in turns), None), 'New turn delivery row missing')
    turn = pending['AXUniqueId'].removesuffix(':delivery')
    status = 'send.status.uploading' if index == 1 else 'send.status.sending'
    assert pending['AXLabel'] == catalog.text(status), 'Unacked send must show its current delivery phase'
    turns.append(turn)
    assert ui.element(turn + (':user-text' if index == 1 else ':user')).get('AXLabel') == message, 'New turn text changed'
    ui.capture(f'round-{index}-sent')
    if index == 1:
        ui.wait(lambda _: trace.reserved_space() is not None, 'Send landing geometry missing')
        assert trace.reserved_space() > 20, 'An ordinary send must still reserve room for its reply'
    ui.axe('tap', '--id', 'send-complete')
    ui.wait(lambda items: any(i.get('AXLabel') == f'Calls: {index} · accepted' for i in items), 'Receipt missing')
    ui.axe('tap', '--id', 'send-reply')
    ui.wait(lambda items: any(i.get('AXLabel') == f'Calls: {index} · idle' for i in items), 'Reply did not settle')
    assert not ui.element('session-input').get('AXValue'), 'Sent draft reappeared'
    ui.capture(f'round-{index}-replied')
assert len(set(turns)) == 3, 'Successive messages reused a turn identity'
# Return to the beginning of the real collection and confirm history survived.
ui.axe('swipe', '--start-x', '200', '--start-y', '260', '--end-x', '200', '--end-y', '500', '--duration', '.5', '--post-delay', '.6')
ui.axe('swipe', '--start-x', '200', '--start-y', '260', '--end-x', '200', '--end-y', '600', '--duration', '.5', '--post-delay', '.6')
ui.element(turns[0] + ':user')
ui.capture('history-retained')
trace.verify(3)
print('PASS: three accepted turns, distinct identities, cleared inputs and retained history')
