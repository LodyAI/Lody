"""Run on an open creation form (production or offline create-parity fixture).
Verify blank taps and picker taps dismiss IME without blocking search focus.
"""
import sys
from driver import UI
ui = UI(sys.argv[1], sys.argv[2])

def tap_frame(frame):
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.6')

def focus_composer():
    tap_frame(ui.element('create-session-input')['frame'])
    ui.wait_for_keyboard('create-session-input')

def hidden():
    ui.wait(lambda items: not ui.visible_keyboard(items), 'Keyboard must dismiss')

focus_composer()
ui.axe('tap', '-x', '200', '-y', '180', '--post-delay', '.6')
hidden()
focus_composer()
field = ui.element('create-session-input')['frame']
picker = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button' and i['frame']['y'] > 200 and i['frame']['y'] + i['frame']['height'] < field['y'] and i['frame']['width'] > 150), None), 'Missing context picker')
tap_frame(picker['frame'])
hidden()
search = ui.wait(lambda items: next((i for i in items if i.get('type') == 'TextField' and i.get('AXUniqueId') != 'create-session-input'), None), 'Picker must still open on the same tap')
tap_frame(search['frame'])
ui.wait(lambda items: ui.visible_keyboard(items), 'Search must accept keyboard focus')
def search_uses_keyboard_space(items):
    keyboard = ui.visible_keyboard(items)
    if not keyboard:
        return False
    composer = next((i for i in items if i.get('AXUniqueId') == 'create-session-input'), None)
    search = next((i for i in items if i.get('type') == 'TextField' and i.get('AXUniqueId') != 'create-session-input'), None)
    return search and search['frame']['y'] + search['frame']['height'] <= keyboard['y'] + 1 and (composer is None or composer['frame']['y'] >= keyboard['y'])
ui.wait(search_uses_keyboard_space, 'Search stays above IME while composer stays under it')
ui.screenshot('search-focused')
ui.axe('tap', '-x', '4', '-y', '180', '--post-delay', '.6')
hidden()
ui.wait(lambda items: not any(i.get('type') == 'TextField' and i.get('AXUniqueId') != 'create-session-input' for i in items), 'Blank tap must collapse the picker too')
ui.screenshot('picker-dismissed')
focus_composer()
ui.screenshot('composer-restored')
print('PASS: blank/picker taps dismiss keyboard; picker search can refocus')
