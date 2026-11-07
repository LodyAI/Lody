"""Last-turn context menu, full-screen composer, attachment edits and failed-send retention."""
import json
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])

def hold(identifier):
    frame = ui.element(identifier)['frame']
    ui.axe('touch', '-x', str(frame['x'] + frame['width'] - 35), '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
    ui.wait(lambda items: any((item.get('AXLabel') or '').casefold() == catalog.system('copy').casefold() for item in items), 'Message menu did not open')

def open_editor():
    hold('editable:user')
    ui.axe('tap', '--label', catalog.text('native.chat.editAction'), '--post-delay', '.8')
    ui.element('edit-message-input')
    screen_height = ui.state()[0]['frame']['height']
    keyboard = ui.wait(lambda items: next((item['frame'] for item in items if (item.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar') and item['frame']['y'] < screen_height - 150), None), 'Editor did not focus the keyboard')
    button = ui.element('session-send')
    assert button['enabled'], 'Editor send button is disabled for a valid original message'
    send = button['frame']
    assert send['y'] + send['height'] <= keyboard['y'] + 1, 'Keyboard covers the editor send button'

ui.axe('drag', '--start-x', '190', '--start-y', '250', '--end-x', '190', '--end-y', '570', '--duration', '.5', '--post-delay', '.7')
hold('earlier:user')
assert not any(item.get('AXLabel') == catalog.text('native.chat.editAction') for item in ui.state())
ui.capture('earlier-menu')
ui.axe('tap', '-x', '20', '-y', '600', '--post-delay', '.8')
ui.wait(lambda items: not any((item.get('AXLabel') or '').casefold() == catalog.system('copy').casefold() for item in items), 'Message menu did not dismiss')
open_editor()
assert ui.element('edit-message-input')['AXValue'] == 'Original prompt'
assert not any(item.get('AXUniqueId') == 'old-reply:text' for item in ui.state())
ui.capture('editor')
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.6')
assert ui.element('session-input')['AXValue'] == 'Keep this chat draft'
ui.element('old-reply:text')
ui.capture('cancelled')
open_editor()
ui.axe('tap', '--label', catalog.text('native.chat.attachment.remove', name='original.txt'))
assert not any(item.get('AXLabel') == catalog.text('native.chat.attachment.remove', name='original.txt') for item in ui.state())
ui.paste_file('edit-message-input')
ui.axe('tap', '--id', 'edit-message-input')
ui.axe('type', ' revised')
text = ui.element('edit-message-input')['AXValue']
ui.capture('attachments-edited')
ui.axe('tap', '--id', 'session-send', '--post-delay', '.2')
ui.element('edit-message-busy')
ui.capture('sending')
ui.element('edit-message-error')
assert ui.element('edit-message-input')['AXValue'] == text
ui.capture('failed-kept')
ui.axe('tap', '--id', 'session-send', '--post-delay', '2')
ui.element('session-input')
assert ui.element('session-input')['AXValue'] == 'Keep this chat draft'
payload = json.loads(ui.element('edit-fixture-payload')['AXLabel'])
assert payload['expectedUserTurnId'] == 'editable'
assert payload['retainedIds'] == ['original:1']
assert len(payload['attachments']) == 1
assert payload['text'] == text
assert ui.element('edit-fixture-count')['AXLabel'] == '2'
assert not any(item.get('AXUniqueId') == 'old-reply:text' for item in ui.state())
ui.capture('replaced')
print('PASS: last-message menu, full-screen editing, cancellation, attachment add/remove, failure retention and replacement')

ui.open_case('edit-message-unknown')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'edit-fixture-count' and i.get('AXLabel') == '0' for i in items), 'Fresh editor fixture missing')
open_editor()
ui.axe('tap', '--id', 'session-send')
ui.element('edit-message-retry')
assert not ui.element('session-send')['enabled'], 'Uncertain edit must not be sent again'
assert ui.element('edit-message-input')['AXValue'] == 'Original prompt'
ui.capture('unknown-retained')
ui.axe('tap', '--id', 'edit-message-retry')
ui.element('edit-message-retry')
assert not ui.element('session-send')['enabled'], 'Unconfirmed read must not unlock sending'
ui.axe('tap', '--id', 'edit-message-retry')
ui.element('session-input')
assert ui.element('edit-fixture-count')['AXLabel'] == '1', 'Readback replayed the edit'
ui.capture('unknown-confirmed')

ui.open_case('edit-message-load-failure')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'edit-fixture-count' and i.get('AXLabel') == '0' for i in items), 'Fresh editor fixture missing')
hold('editable:user')
ui.axe('tap', '--label', catalog.text('native.chat.editAction'))
ui.element('edit-message-error')
ui.capture('load-failed')
ui.axe('tap', '--id', 'edit-message-retry')
ui.element('edit-message-input')
assert ui.element('edit-message-input')['AXValue'] == 'Original prompt'
ui.axe('tap', '--label', catalog.text('common.cancel'))
ui.element('session-input')
print('PASS: uncertain edits only read back, no write replay, and failed preparation can retry')
