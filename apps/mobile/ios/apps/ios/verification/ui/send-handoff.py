"""Real form-sheet dismissal/root push with the same local native message."""
import os
import sys
import subprocess
import json
from pathlib import Path
from driver import UI
import catalog
from send_motion import ThrowTrace
ui = UI(*sys.argv[1:])
throw_trace = ThrowTrace(ui)
ui.axe('tap', '--id', 'create-session-input', '--tap-style', 'physical', '--post-delay', '.5')
# The runner establishes the English software keyboard once for this batch.
ui.wait_for_keyboard('create-session-input')
ui.type_into('create-session-input', 'hi')
ui.wait_for_keyboard('create-session-input')
draft = ui.element('create-session-input')['AXValue']
ui.capture('source')
ui.axe('tap', '--id', 'session-send', '--tap-style', 'physical')
ui.element('send-status')
delivery = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':delivery')), None), 'Target delivery row missing')
turn = delivery['AXUniqueId'].removesuffix(':delivery')
assert delivery['AXLabel'] == catalog.text('send.status.awaitingConnection'), 'Unacked send must show its delivery phase above the message'
assert not any(i.get('AXUniqueId') == turn + ':duration' for i in ui.state()), 'Unacked send must not show a working duration'
assert draft == ui.element(turn + ':user')['AXLabel']
assert ui.element('send-status')['AXLabel'] == 'Calls: 0 · waiting', 'Creation waited for network or dispatched offline'
ui.capture('target-offline')
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
relay = json.loads((container / 'tmp/lody-production-composer-relay.json').read_text())
assert relay['sameComposer'], 'The destination replaced the source composer'
assert relay['destinationContentHidden'], 'Destination text/status remained visible beneath the relayed glass'
assert relay['destinationContentRestored'], 'Adoption did not restore destination content'
assert relay['placeholderHidden'], 'The destination exposed a second composer while awaiting adoption'
assert relay['inputBefore'] == relay['inputAfter'], 'Adoption changed focus, selection, or appearance'
assert relay['inputBefore']['focused'], 'The source lost keyboard focus before adoption'
source, adopted = relay['source'], relay['adopted']
assert abs(source[0] - adopted[0]) < 1.5 and abs(source[2] - adopted[2]) < 1.5, relay
assert abs(source[1] + source[3] - adopted[1] - adopted[3]) < 1.5, 'Adoption moved the keyboard edge'
# Chat adds its fullscreen grabber above the form's input, keeping the bottom fixed.
grabber = ui.element('session-grabber')['frame']
assert abs(adopted[3] - source[3] - grabber['height']) < 1.5, relay
ui.wait_for_keyboard('session-input')
(ui.output / 'composer-relay.json').write_text(json.dumps(relay, indent=2))
delivery_frame = ui.element(turn + ':delivery')['frame']
geometry_errors = []

def assert_row_stable(identifier, reference, stage):
    frame = ui.element(identifier)['frame']
    print(f'{stage}: {identifier} frame {frame}', flush=True)
    for dimension in ['y', 'height']:
        if abs(frame[dimension] - reference[dimension]) >= 1.5:
            geometry_errors.append(f'{stage}: {identifier} {dimension} shifted from {reference} to {frame}')

ui.axe('tap', '--id', 'send-connect')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 1 · creating' for i in items), 'Creation did not start')
assert_row_stable(turn + ':delivery', delivery_frame, 'connected')
ui.axe('tap', '--id', 'send-fail')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('send.alert.title') for i in items), 'Creation failure missing')
ui.axe('tap', '--label', catalog.system('ok'))
assert not ui.element('session-input').get('AXValue'), 'Failure jumped into the destination input'
assert ui.element(turn + ':user')['AXLabel'] == draft
assert ui.element(turn + ':pending')['AXLabel'] == catalog.text('native.chat.message.retry')
ui.capture('target-failure-retained')
ui.axe('tap', '--id', turn + ':pending')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 2 · creating' for i in items), 'Explicit creation retry did not start')
ui.capture('target-retrying')
assert_row_stable(turn + ':delivery', delivery_frame, 'retrying')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · sending' for i in items), 'First turn did not start after creation')
assert_row_stable(turn + ':delivery', delivery_frame, 'created')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · accepted' for i in items), 'Receipt missing')
ui.wait(lambda items: not any(i.get('AXUniqueId') == turn + ':delivery' for i in items), 'Accepted send kept the delivery status')
previous_duration = []

def settled_duration(items):
    row = next((i for i in items if i.get('AXUniqueId') == turn + ':duration'), None)
    if not row:
        previous_duration.clear()
        return None
    frame = row['frame']
    previous = previous_duration[-1] if previous_duration else None
    previous_duration[:] = [frame]
    if previous and all(abs(frame[dimension] - previous[dimension]) < 0.5 for dimension in ['y', 'height']):
        return row
    return None

timer = ui.wait(settled_duration, 'Working duration did not settle')
assert timer['AXLabel'] != catalog.text('native.chat.transcript.status.confirming'), 'Accepted send must start working duration'
timer_frame = timer['frame']
assert_row_stable(turn + ':duration', timer_frame, 'accepted')
ui.capture('target-accepted')
ui.axe('tap', '--id', 'send-start-reply')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · idle' for i in items), 'First reply did not reconcile pending')
assert_row_stable(turn + ':duration', timer_frame, 'first reply')
first_label = ui.element(turn + ':duration')['AXLabel']
ui.wait(lambda items: any(i.get('AXUniqueId') == turn + ':duration' and i.get('AXLabel') != first_label for i in items), 'Timer stopped after takeover')
assert_row_stable(turn + ':duration', timer_frame, 'tick after takeover')
ui.capture('target-reconciled')
assert not geometry_errors, '\n'.join(geometry_errors)
print('PASS: immediate first turn, failure/retry, stable delivery then working duration through first reply takeover')

if not os.environ.get('LODY_UI_NATIVE'):
    throw_trace.verify(1)
