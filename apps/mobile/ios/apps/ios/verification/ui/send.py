"""Immediate offline media/text, retained failure, explicit retry and history reconciliation."""
import os
import sys
from driver import UI
import catalog
from send_motion import ThrowTrace
ui = UI(*sys.argv[1:])
trace = ThrowTrace(ui)
progress = ui.element('send-upload-progress')['frame']
viewport = ui.element('chat-transcript')['frame']
assert progress['width'] >= 44 and progress['height'] >= 44, 'Upload progress must retain a 44 pt touch target'
assert progress['x'] + progress['width'] <= viewport['x'] + viewport['width'], 'Upload progress fell outside the screen'
ui.axe('tap', '--id', 'session-input')
ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == 'inputView' and i['frame']['height'] > 200), None),
        'The software keyboard must be ready before typing')
ui.type_into('session-input', 'Offline send\nKeep my attachment')
draft = ui.element('session-input')['AXValue']
ui.capture('draft')
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':user-text')), None), 'Offline message missing')
# Dismiss the keyboard away from the message that is still moving after Send.
frame = ui.element('chat-transcript')['frame']
ui.axe('tap', '-x', str(frame['x'] + 40), '-y', str(frame['y'] + 20), '--post-delay', '.5')
timer = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':delivery')), None), 'Offline delivery missing')
assert timer['frame']['y'] >= frame['y'] - 1, 'Collapsed composer scrolled the delivery status above the transcript'
turn = timer['AXUniqueId'].removesuffix(':delivery')
assert timer['AXLabel'] == catalog.text('send.status.awaitingConnection'), 'Unacked send must show its delivery phase above the message'
assert ui.element('send-status')['AXLabel'] == 'Calls: 0 · waiting'
assert ui.element(turn + ':user-text')['AXLabel'] == draft
assert not ui.element('session-input').get('AXValue')
ui.element(turn + ':attachment:fixture-file')
ui.capture('offline')

def sending(items):
    return any(i.get('AXLabel') == 'Calls: 1 · sending' for i in items)

# One physical tap on this row can miss. Try once more before failing the case.
ui.axe('tap', '--id', 'send-connect')
try:
    ui.wait(sending, 'Connected send did not start', timeout=8)
except AssertionError:
    ui.axe('tap', '--id', 'send-connect')
    ui.wait(sending, 'Connected send did not start')
ui.axe('tap', '--id', 'send-fail')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('send.alert.title') for i in items), 'Failure alert missing')
assert any(i.get('AXLabel') == catalog.text('send.error.freeTurnLimit') for i in ui.state()), 'Free turn limit explanation missing'
ui.capture('turn-limit-alert')
ui.axe('tap', '--label', catalog.system('ok'))
assert not ui.element('session-input').get('AXValue'), 'Failed text jumped back into input'
assert ui.element(turn + ':user-text')['AXLabel'] == draft
ui.element(turn + ':attachment:fixture-file')
assert ui.element(turn + ':pending')['AXLabel'] == catalog.text('native.chat.message.retry')
ui.capture('failure-retained')
ui.axe('tap', '--id', turn + ':pending')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 2 · sending' for i in items), 'Explicit retry did not start')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 2 · accepted' for i in items), 'Receipt missing')
assert ui.element(turn + ':duration')['AXLabel'] != catalog.text('native.chat.transcript.status.confirming'), 'Accepted send must start working duration'
ui.capture('waiting-reply')
ui.axe('tap', '--id', 'send-reply')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 2 · idle' for i in items), 'Reply did not reconcile pending')
assert ui.element(turn + ':user-text')['AXLabel'] == draft
ui.element(turn + ':attachment:fixture-file')
ui.capture('reconciled')
ui.axe('tap', '--id', 'session-input')
# AXe `type` emits Shift+digit on this Simulator (2 → @, 3 → #). Use letters only.
ui.type_into('session-input', 'second next draft')
# Let the measured throw settle before driving another input mutation.
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · sending' for i in items), 'Next send missing')
ui.type_into('session-input', 'third next draft')
ui.axe('tap', '--id', 'send-fail')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('send.alert.title') for i in items), 'Failure alert missing')
ui.axe('tap', '--label', catalog.system('ok'))
assert (ui.element('session-input').get('AXValue') or '').casefold() == 'third next draft', 'Failure overwrote new input'
assert not ui.element('session-send')['enabled'], 'Retained failure must not be overwritten by a new send'
ui.capture('new-draft-preserved')

# A completed Session can retire a published outbox row while the native clear
# token is unchanged after view restoration. The empty pending prop owns this
# transition and must release only that published send.
ui.axe('tap', '--id', 'send-toggle-pending')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · idle' for i in items), 'Failed fixture did not retire')
ui.axe('tap', '--id', 'send-toggle-pending')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · unknown' for i in items), 'Stale pending fixture did not load')
assert not ui.element('session-send')['enabled'], 'A pending send must lock duplicate submission'
ui.capture('stale-pending')
ui.axe('tap', '--id', 'send-toggle-pending')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · idle' for i in items), 'Completed fixture did not retire pending state')
send = ui.element('session-send')
assert send['AXLabel'] == catalog.text('native.chat.composer.send'), 'Completed Session left the composer stuck in Loading'
if not ui.element('session-input').get('AXValue'):
    ui.axe('tap', '--id', 'session-input')
    ui.type_into('session-input', 'after completion')
assert ui.element('session-send')['enabled'], 'Completed Session did not accept a new draft'
ui.capture('completed-unlocked')
ui.axe('tap', '--id', 'send-toggle-pending')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · unknown' for i in items), 'Unknown-send fixture did not load')
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'draft during confirmation')
confirmation_draft = ui.element('session-input').get('AXValue') or ''
# AXe can leave Shift active on CI. Verify input separately, then compare the
# exact pre-reply value so this check detects edits as well as a cleared draft.
assert confirmation_draft.casefold() == 'draft during confirmation', 'Confirmation draft input did not arrive'
assert not ui.element('session-send')['enabled']
ui.capture('causal-confirming')
ui.axe('tap', '--id', 'send-reply')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · idle' for i in items), 'A causally matching reply without its user row did not retire pending state')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'session-send' and i.get('enabled') for i in items), 'A confirmed reply left the next draft locked')
assert ui.element('session-input').get('AXValue') == confirmation_draft, 'Confirmation changed the next draft'
ui.capture('causal-unlocked')
if not os.environ.get('LODY_UI_NATIVE'):
    trace.verify(2)
print('PASS: offline media/text, retained failure and explicit retry without another throw, history takeover, new draft preserved')
