"""A dismissed draft stays a one-line capsule with its attachments stacked inside, and reopens intact."""
import sys
from driver import UI

ui = UI(*sys.argv[1:])


def visible(identifier):
    return next((item for item in ui.state() if item.get('AXUniqueId') == identifier and item.get('frame', {}).get('height', 0) > 0), None)


def dismiss():
    field = ui.element('session-input')['frame']
    ui.axe('tap', '-x', '200', '-y', str(field['y'] - 90), '--post-delay', '.6')
    ui.wait(lambda items: abs(ui.element('session-input')['frame']['height'] - 48) <= 1,
            'Dismissed draft did not return to the 48-point capsule')


def assert_resting_draft(label):
    field = ui.element('session-input')['frame']
    attach = ui.element('session-attach')['frame']
    stack = visible('session-attachment-stack')
    send = visible('session-send')
    assert stack, f'{label}: attachment stack is missing from the capsule'
    frame = stack['frame']
    assert frame['x'] >= attach['x'] + attach['width'] - 1 and frame['x'] + frame['width'] <= field['x'] + field['width'], \
        f'{label}: attachment stack is not inside the capsule after Add: {frame}'
    assert abs(frame['y'] + frame['height'] / 2 - field['y'] - field['height'] / 2) <= 1, f'{label}: stack is not centered'
    assert send and send.get('enabled', True), f'{label}: a resting draft must offer Send'


ui.axe('tap', '--id', 'session-input', '--tap-style', 'physical', '--post-delay', '.8')
pasted = ui.paste_file('session-input')
dismiss()
assert_resting_draft('attachment only')
ui.capture('rest-attachment')

ui.axe('tap', '--id', 'session-input', '--tap-style', 'physical', '--post-delay', '.8')
ui.type_into('session-input', 'first line of the draft\nsecond line')
dismiss()
assert_resting_draft('text and attachment')
ui.capture('rest-draft')

ui.axe('tap', '--id', 'session-input', '--tap-style', 'physical', '--post-delay', '.8')
ui.wait(lambda items: ui.element('session-input')['frame']['height'] >= 120, 'Tapping the capsule did not reopen the sheet')
value = ui.element('session-input').get('AXValue') or ''
assert 'second line' in value.lower(), f'Reopened draft lost its text: {value!r}'
assert any(item.get('AXLabel') == pasted for item in ui.state()), 'Reopened draft lost its attachment'
ui.capture('reopened')
print('PASS: resting draft stays one capsule with stacked attachments and Send, and reopens intact')
