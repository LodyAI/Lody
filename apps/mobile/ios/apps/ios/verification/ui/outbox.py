"""The workspace dispatcher sends without a message page, releases slots, and retains a retryable preparation failure."""
import json
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])


def state():
    return json.loads(ui.element('outbox-state')['AXLabel'])


def wait(**expected):
    return ui.wait(lambda _: all(state().get(key) == value for key, value in expected.items()), f'Outbox did not reach {expected}')


def compose(text):
    ui.axe('tap', '--id', 'outbox-compose')
    ui.axe('tap', '--id', 'create-session-input')
    ui.type_into('create-session-input', text)
    draft = ui.element('create-session-input')['AXValue']
    assert ui.element('session-send')['enabled'], 'Composer did not enable submission'
    ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
    return draft


wait(calls=0, reserves=0)
compose('send after leaving the sheet')
wait(calls=1, sending=1, reserves=1)
assert not any(i.get('AXUniqueId') == 'create-session-input' for i in ui.state())
ui.capture('offscreen-sending')
ui.axe('tap', '--id', 'outbox-confirm')
wait(accepted=1, reserves=0)
ui.capture('offscreen-accepted')

ui.axe('tap', '--id', 'outbox-fail-next')
failed_text = compose('keep this failed draft')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('send.alert.title') for i in items), 'Preparation failure alert missing')
ui.capture('preparation-failure-alert')
ui.axe('tap', '--label', catalog.system('ok'))
wait(calls=1, failed=1, reserves=0)
assert failed_text in ui.element('outbox-2')['AXLabel']
ui.capture('preparation-retry')
ui.axe('tap', '--id', 'outbox-2')
wait(calls=2, sending=1, failed=0, reserves=1)
ui.axe('tap', '--id', 'outbox-confirm')
wait(accepted=2, reserves=0)
ui.capture('retry-accepted')

ui.axe('tap', '--id', 'outbox-nine')
wait(calls=10, sending=8, waiting=1, reserves=8)
ui.capture('eight-active-one-waiting')
ui.axe('tap', '--id', 'outbox-confirm')
wait(calls=11, sending=8, waiting=0, reserves=8)
ui.capture('next-slot-started')
ui.axe('tap', '--id', 'outbox-confirm-all')
wait(accepted=11, sending=0, waiting=0, reserves=0)
ui.capture('all-accepted')
ui.axe('tap', '--id', 'outbox-quota-next')
quota_text = compose('keep this quota draft')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('send.error.freeSessionLimit') for i in items), 'Free session limit alert missing')
ui.capture('session-limit-alert')
ui.axe('tap', '--label', catalog.system('ok'))
wait(calls=11, failed=1, reserves=0)
for _ in range(3):
    if any(item.get('AXUniqueId') == 'outbox-12' for item in ui.state()):
        break
    ui.axe('swipe', '--start-x', '200', '--start-y', '740', '--end-x', '200', '--end-y', '380', '--duration', '0.4', '--post-delay', '0.5')
assert quota_text in ui.element('outbox-12')['AXLabel'], 'Quota rejection discarded the pending draft'
ui.capture('session-limit-draft')
print(json.dumps(state()))
