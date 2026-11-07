"""Guide preference sends into the transcript and steers, without a queue card."""
import json
import sys
from driver import UI
import catalog
from send_motion import ThrowTrace

ui = UI(*sys.argv[1:])
trace = ThrowTrace(ui)


def dismiss_keyboard():
    ui.axe('tap', '-x', '5', '-y', str(ui.element('chat-transcript')['frame']['y'] + 10), '--post-delay', '.6')


def user_text(identifier):
    dismiss_keyboard()
    return ui.wait(lambda items: next((i.get('AXLabel') for i in items if i.get('AXUniqueId') in [identifier + ':user', identifier + ':user-text']), None), 'Retained guide text missing')


ui.axe('tap', '--id', 'send-connect')
assert ui.element('session-stop')['enabled'], 'Running with no draft must offer Stop'
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'steer on send')
ui.wait(
    lambda items: any(
        i.get('AXUniqueId') == 'session-send' and i.get('enabled') for i in items
    ),
    'Typing did not offer Send',
)
ui.axe('tap', '--id', 'session-send')
ui.wait(
    lambda items: any(i.get('AXLabel') == 'Calls: 1 · sending' for i in items),
    'Guide write did not start',
)
assert not any(
    (i.get('AXUniqueId') or '').endswith(':queued') for i in ui.state()
), 'Guide send must not appear in the queue'
ui.axe('tap', '--id', 'send-complete')
ui.wait(
    lambda items: next(
        (
            i
            for i in items
            if i.get('AXUniqueId') == 'control-request'
            and (i.get('AXLabel') or '').startswith('{')
        ),
        None,
    ),
    'Guide send did not auto-steer',
)
request = json.loads(ui.element('control-request')['AXLabel'])
assert request['action'] == 'steer', request
assert request['turnId'] == 'running-reply', request
turn = request['messageId']
assert turn
assert ui.element('send-status')['AXLabel'] == 'Calls: 1 · uploaded', 'A durable guide write is not an acknowledgement'
dismiss_keyboard()
delivery = ui.element(turn + ':delivery')['frame']
assert ui.element(turn + ':delivery')['AXLabel'] == catalog.text('native.chat.message.guide.confirming')
bubble = ui.element(turn + ':user')['frame']
assert delivery['y'] + delivery['height'] <= bubble['y'] + 1, 'Guidance belongs above its own bubble'
ui.capture('guide-pending')
ui.wait(lambda _: trace.reserved_space() is not None, 'Guide landing geometry missing')
assert abs(trace.reserved_space()) < 1, 'Guidance must not reserve empty space below the transcript'
ui.element('running-reply:text')
ui.axe('tap', '--id', 'send-complete')
ui.wait(
    lambda items: any(
        i.get('AXUniqueId') == turn + ':user' for i in items
    ),
    'Guide send did not land in the transcript',
)
assert not any(
    (i.get('AXUniqueId') or '').endswith(':queued') for i in ui.state()
), 'Guide send must stay out of the queue after steer'
assert ui.element('queue-count')['AXLabel'] == 'Queue: 0'
assert not ui.element('session-input').get('AXValue'), 'Guide send reappeared as a draft'
ui.capture('guide-applied')

# A definite pre-write failure retains the original text and offers one retry.
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'retry this guide')
assert ui.element('inputView')['frame']['height'] > 200, 'Retry must be exercised with the software keyboard visible'
retry_text = ui.element('session-input')['AXValue']
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 2 · sending' for i in items), 'Second guide did not start')
ui.axe('tap', '--id', 'send-fail')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('send.alert.title') for i in items), 'Failure alert missing')
ui.capture('guide-failure-alert')
ui.axe('tap', '--label', catalog.system('ok'))
retry = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':pending') and i.get('AXLabel') == catalog.text('native.chat.message.retry')), None), 'Guide retry missing')
retry_id = retry['AXUniqueId'].removesuffix(':pending')
assert user_text(retry_id) == retry_text
ui.capture('guide-failure-retained')
ui.axe('tap', '--id', retry['AXUniqueId'])
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · sending' for i in items), 'Guide retry did not start')
ui.axe('tap', '--id', 'send-complete')
retried = json.loads(ui.element('control-request')['AXLabel'])
assert retried['messageId'] == retry_id, 'Retry changed the durable identity'
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 3 · uploaded' for i in items), 'Retried guide not accepted')
ui.capture('guide-retried')

# Finish the target while preparation is in flight. The same send dispatches normally.
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'after the turn ends')
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 4 · sending' for i in items), 'Race send did not start')
ui.axe('tap', '--id', 'send-reply')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 4 · accepted' for i in items), 'Ended target orphaned the guide')
fallback = json.loads(ui.element('control-request')['AXLabel'])
assert fallback['action'] == 'dispatch', fallback
ui.capture('guide-ended-target')

# An ambiguous ACK retains the user row, locks replay and is never called accepted.
ui.axe('tap', '--id', 'send-reset-guide')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 4 · idle' for i in items), 'Guide fixture did not reset')
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'keep uncertain guide')
unknown_text = ui.element('session-input')['AXValue']
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 5 · sending' for i in items), 'Uncertain guide did not start')
ui.axe('tap', '--id', 'send-complete')
unknown = json.loads(ui.element('control-request')['AXLabel'])['messageId']
ui.axe('tap', '--id', 'send-fail')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 5 · uploaded' for i in items), 'Ambiguous guide incorrectly confirmed')
assert user_text(unknown) == unknown_text
assert not any(i.get('AXLabel') == catalog.text('native.chat.message.retry') and (i.get('AXUniqueId') or '').endswith(':pending') for i in ui.state()), 'An uncertain write must not offer retry'
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'next draft')
assert ui.element('session-send')['enabled'], 'An uncertain guide must allow a new message'
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
ui.axe('tap', '--id', 'send-complete')
next_turn = json.loads(ui.element('control-request')['AXLabel'])['messageId']
assert next_turn != unknown, 'A new guide must have its own identity'
dismiss_keyboard()
ui.axe('swipe', '--start-x', '150', '--start-y', '440', '--end-x', '150', '--end-y', '700', '--duration', '.4', '--post-delay', '.6')
ui.element(unknown + ':delivery')
ui.element(next_turn + ':delivery')
ui.capture('guide-concurrent-unknown')
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'another pending guide')
assert ui.element('session-send')['enabled'], 'A confirming guide must allow another guide'
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
ui.axe('tap', '--id', 'send-complete')
third_turn = json.loads(ui.element('control-request')['AXLabel'])['messageId']
assert third_turn not in [unknown, next_turn]
dismiss_keyboard()
ui.axe('swipe', '--start-x', '150', '--start-y', '440', '--end-x', '150', '--end-y', '730', '--duration', '.4', '--post-delay', '.6')
ui.element(next_turn + ':delivery')
ui.element(third_turn + ':delivery')
ui.capture('guide-concurrent-confirming')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: not any(i.get('AXUniqueId') == next_turn + ':delivery' for i in items), 'Accepted guidance did not dismiss its own status')
ui.element(unknown + ':delivery')
ui.element(third_turn + ':delivery')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: not any(i.get('AXUniqueId') == third_turn + ':delivery' for i in items), 'Last guidance status did not dismiss')
ui.element(unknown + ':delivery')
ui.capture('guide-uncertain')
trace.verify(6)
print(
    json.dumps(
        {
            'action': request['action'],
            'messageId': turn,
            'queue': 0,
            'definiteFailureRetry': retry_id,
            'endedTarget': fallback,
            'uncertainNoReplay': unknown,
        }
    )
)
