"""Settings choices update in place through native pop-up menus."""
import sys
import plistlib
import re
import time
from pathlib import Path
import subprocess
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
ui.axe('tap', '--id', 'appearance', '--post-delay', '.5')
for value in ["soft","black","soft"]:
    row = ui.element('appearance')
    assert row['frame']['height'] >= 44
    ui.axe('tap', '--id', 'appearance', '--post-delay', '.5')
    ui.capture(f'{value}-menu')
    ui.axe('tap', '--wait-timeout', '5', '--label', catalog.text(f'settings.appearance.{value}'), '--post-delay', '.7')
    ui.wait(lambda _: ui.element('appearance').get('AXValue') == catalog.text(f'settings.appearance.{value}'), 'Selected value did not update')
    ui.element('appearance')
    ui.element('app-icon')
    ui.capture(f'{value}-selected')
for value in ['purple', 'pink', 'indigo', 'blue']:
    assert ui.element('accent-color')['frame']['height'] >= 44
    ui.axe('tap', '--id', 'accent-color', '--post-delay', '.3')
    ui.axe('tap', '--wait-timeout', '5', '--label', catalog.text(f'settings.appearance.{value}'), '--post-delay', '.5')
    ui.wait(lambda _: ui.element('accent-color').get('AXValue') == catalog.text(f'settings.appearance.{value}'), 'Accent selection did not update')
    ui.capture(f'accent-{value}')

# UIKit hosts its picker in ColorPickerUIService, which AXe cannot traverse.
# These coordinates are from the verified iPhone 17 Pro framebuffer (402 x 874 pt).
# Require its native host, capture the real service, then assert the actual durable result.
def open_color_picker():
    ui.axe('tap', '--id', 'accent-color', '--post-delay', '.3')
    ui.axe('tap', '--wait-timeout', '5', '--label', catalog.text('settings.appearance.customPicker'), '--post-delay', '.7')
    ui.element('UIColorPicker')
    time.sleep(2)


container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
prefs = container / 'Library/Preferences/ai.lody.mobile.plist'
def saved_color():
    return plistlib.loads(prefs.read_bytes()).get('accentColor', '')

open_color_picker()
ui.capture('custom-picker')
ui.axe('tap', '-x', '110', '-y', '312', '--post-delay', '.8')
ui.capture('custom-color')
ui.axe('tap', '-x', '375', '-y', '100', '--post-delay', '.8')
ui.wait(lambda _: ui.element('accent-color').get('AXValue') == catalog.text('settings.appearance.custom'), 'Custom color was not retained')
ui.wait(lambda _: re.fullmatch(r'#[0-9A-F]{6}', saved_color()), 'Custom color was not persisted')
custom = saved_color()
ui.capture('custom-selected')
# Cold launch proves native startup restore the persisted choice.
subprocess.run(['xcrun', 'simctl', 'terminate', ui.udid, 'ai.lody.mobile'], check=True)
launch = ['xcrun', 'simctl', 'launch', ui.udid, 'ai.lody.mobile', '--ui-verify']
subprocess.run(launch, check=True)
ui.invalidate_axe()
ui.element('ui-verify-ready', timeout=120)
ui.open_case('appearance-preview')
ui.element('appearance')
ui.axe('tap', '--id', 'appearance', '--post-delay', '.5')
ui.wait(lambda _: ui.element('accent-color').get('AXValue') == catalog.text('settings.appearance.custom'), 'Cold launch lost custom color')
assert saved_color() == custom
open_color_picker()
ui.capture('custom-restored')
ui.axe('tap', '-x', '375', '-y', '100', '--post-delay', '.6')
assert saved_color() == custom
ui.axe('tap', '--id', 'accent-color', '--post-delay', '.3')
ui.axe('tap', '--wait-timeout', '5', '--label', catalog.text('settings.appearance.blue'), '--post-delay', '.4')

ui.axe('tap', '--id', 'app-icon', '--post-delay', '.6')
first, second = ui.element('app-icon-default'), ui.element('app-icon-Aqua')
a, b = first['frame'], second['frame']
assert abs(a['y'] - b['y']) < 2 and b['x'] > a['x']
assert a['height'] >= 44 and a['width'] >= 44
# Each cell owns one third of the collection's width, including the empty third slot.
assert 90 < a['width'] < 140, a
ui.capture('icon-grid')
def selected(value):
    return ui.element(f'app-icon-{value}').get('AXValue') == catalog.text('native.chat.attachment.selected')

for value in ['default', 'Aqua', 'default']:
    if selected(value):
        continue
    ui.axe('tap', '--id', f'app-icon-{value}', '--post-delay', '1')
    ui.screenshot(f'icon-{value}-system-confirmation')
    try:
        ui.axe('tap', '--wait-timeout', '5', '--label', 'OK', '--post-delay', '.5', timeout=3, recover=False)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError):
        ui.axe('tap', '-x', '201', '-y', '505', '--post-delay', '.5')
    ui.invalidate_axe()
    ui.wait(lambda _: selected(value), 'System icon change did not complete')
    ui.capture(f'icon-{value}')
ui.axe('tap', '--wait-timeout', '5', '--id', 'BackButton', '--post-delay', '.6')
ui.wait(lambda _: ui.element('app-icon').get('AXValue') == catalog.text('settings.appearance.defaultIcon'), 'Settings did not retain the current icon')
ui.capture('settings-restored')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')
ui.axe('tap', '--wait-timeout', '5', '--label', 'Close Settings', '--post-delay', '.6')
ui.open_case('app-icon-failure-preview')
ui.element('app-icon-default')
assert selected('default')
ui.axe('tap', '--id', 'app-icon-Aqua', '--post-delay', '.5')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('settings.appearance.iconFailed') for i in items), 'Icon failure feedback missing')
ui.capture('icon-failure')
ui.axe('tap', '--wait-timeout', '5', '--label', 'OK', '--post-delay', '.4')
assert selected('default') and not selected('Aqua'), 'A failed change replaced the selected icon'
ui.capture('icon-failure-retained')
print('PASS: UIKit custom colors, three-column icon previews, real icon switching and return navigation.')
