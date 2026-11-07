"""Resting composer is one capsule; focus turns it into an edge-to-edge sheet on the keyboard."""
import statistics
import subprocess
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
input_id = 'session-input' if 'composer-glass-chat' in str(ui.output) else 'create-session-input'


def visible(identifier):
    return any(item.get('AXUniqueId') == identifier and item.get('frame', {}).get('height', 0) > 0 for item in ui.state())


# Form sheets at the medium detent scale their content, so lengths are measured in units of the 44-point Add button.
scale = ui.element('session-attach')['frame']['width'] / 44


# AXe also lists hidden UIKit buttons, so Send counts as shown only when its accent circle is rendered.
def send_rendered(name):
    ui.capture(name)
    send = ui.element('session-send')['frame']
    width = round(ui.state()[0]['frame']['width'])
    pixels = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(ui.output / f'{name}.png'), '-vf', f'scale={width}:-1',
                                      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], timeout=20)
    x, y = round(send['x'] + send['width'] / 2), round(send['y'] + send['height'] / 2)
    r, g, b = (statistics.median(pixels[((y + dy) * width + x + dx) * 3 + c] for dy in range(-2, 3) for dx in range(-2, 3)) for c in range(3))
    return b - r > 30


def assert_capsule(label):
    field = ui.element(input_id)['frame']
    attach = ui.element('session-attach')['frame']
    assert abs(field['height'] - 48 * scale) <= 1, f'{label}: capsule is not 48 points tall: {field}'
    assert field['x'] - 1 <= attach['x'] and attach['x'] + attach['width'] <= field['x'] + 52 * scale, \
        f'{label}: Add is not inside the leading end of the capsule: {attach} in {field}'
    assert abs(attach['y'] + attach['height'] / 2 - field['y'] - field['height'] / 2) <= 1, \
        f'{label}: Add is not vertically centered in the capsule'
    remove = catalog.text('native.chat.attachment.remove', name='')
    has_content = any((item.get('AXLabel') or '').startswith(remove) for item in ui.state())
    assert send_rendered(f'{label}-send') == has_content, f'{label}: resting Send must show only with draft content'
    return field


screen = ui.state()[0]['frame']
rest = assert_capsule('rest')
if input_id == 'session-input':
    assert abs(rest['x'] - 20) <= 1 and abs(screen['width'] - rest['x'] - rest['width'] - 20) <= 1, \
        f'Capsule does not keep 20-point side insets: {rest}'
ui.capture('rest')

ui.axe('tap', '--id', input_id, '--tap-style', 'physical', '--post-delay', '.8')
keyboard = ui.wait(lambda items: next((i['frame'] for i in items if (i.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar')
                                       and i['frame']['y'] < screen['height'] - 150), None), 'Software keyboard did not appear')
predictions = [i['frame']['y'] for i in ui.state() if i.get('AXLabel') == 'Typing Predictions']
keyboard_top = min([keyboard['y']] + predictions)
# A clipboard suggestion replaces the predictions element, leaving only the key rows to measure from.
bar_slack = 0 if predictions else 56
field = ui.element(input_id)['frame']
attach = ui.element('session-attach')['frame']
send = ui.element('session-send')['frame']
model = ui.element('session-model')['frame']
sheet_scale = attach['width'] / 44
rest_inset = 20 * scale
assert field['x'] <= rest['x'] - rest_inset + 1 and field['x'] + field['width'] >= rest['x'] + rest['width'] + rest_inset - 1, \
    f'Focused sheet did not grow past both 20-point capsule insets: {field} from {rest}'
if input_id == 'session-input':
    assert field['x'] <= 1 and field['x'] + field['width'] >= screen['width'] - 1, f'Focused sheet is not edge to edge: {field}'
assert field['height'] >= 120 * sheet_scale, f'Focused text area is shorter than five lines: {field}'
attach_center = (attach['x'] + attach['width'] / 2, attach['y'] + attach['height'] / 2)
send_center = (send['x'] + send['width'] / 2, send['y'] + send['height'] / 2)
assert attach['y'] >= field['y'] + field['height'] - 1, 'Toolbar Add is not below the text'
assert abs(attach_center[1] - send_center[1]) <= 1, 'Toolbar Add and Send do not share a baseline'
assert attach_center[0] <= 40 and send_center[0] >= screen['width'] - 40, 'Add and Send are not at the toolbar ends'
assert model['x'] + model['width'] <= send['x'] + 1, 'Model selector is not leading Send'
assert keyboard_top - 16 - bar_slack <= send['y'] + send['height'] <= keyboard_top + 1, \
    f'Sheet toolbar does not sit on the keyboard: send {send}, keyboard top {keyboard_top}'
ui.capture('sheet')
x = (attach['x'] + attach['width'] + model['x']) / 2
ui.axe('touch', '-x', str(x), '-y', str(send_center[1]), '--down')
try:
    ui.capture('pressed')
finally:
    ui.axe('touch', '-x', str(x), '-y', str(send_center[1]), '--up')
ui.capture('released')

if input_id == 'session-input':
    ui.axe('tap', '-x', '200', '-y', str(field['y'] - 90), '--post-delay', '.6')
else:
    first = ui.element('option-0')['frame']
    row_y = first['y'] + first['height'] / 2
    ui.axe('swipe', '--start-x', '200', '--start-y', str(row_y),
           '--end-x', '200', '--end-y', str(row_y + 200), '--duration', '.5', '--post-delay', '1')
ui.wait(lambda items: abs(ui.element(input_id)['frame']['height'] - 48 * scale) <= 1.5, 'Dismissing did not return to the capsule')
assert_capsule('collapsed')
ui.capture('collapsed-again')

ui.axe('tap', '--id', input_id, '--tap-style', 'physical', '--post-delay', '.8')
buttons = [item for item in ui.state() if item.get('AXUniqueId') == 'session-attach']
assert len(buttons) == 1, 'Sheet duplicated the Add action'
assert buttons[0]['frame']['width'] >= 44 and buttons[0]['frame']['height'] >= 44
ui.axe('tap', '--id', 'session-attach', '--post-delay', '.5')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('native.chat.composer.files') for item in items),
        'Toolbar Add no longer opens its attachment menu')
ui.capture('reopened-add-menu')
print('PASS: resting capsule, edge-to-edge sheet on the keyboard, collapse, and one working Add action')
