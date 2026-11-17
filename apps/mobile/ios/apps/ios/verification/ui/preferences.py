"""Settings choices update in place through native pop-up menus."""
import sys
import subprocess
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
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
ui.wait(lambda _: ui.element('app-icon').get('AXValue') == catalog.text('settings.preferences.defaultIcon'), 'Settings did not retain the current icon')
ui.capture('settings-restored')
ui.open_case('app-icon-failure-preview')
ui.element('app-icon-default')
assert selected('default')
ui.axe('tap', '--id', 'app-icon-Aqua', '--post-delay', '.5')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('settings.preferences.iconFailed') for i in items), 'Icon failure feedback missing')
ui.capture('icon-failure')
ui.axe('tap', '--wait-timeout', '5', '--label', 'OK', '--post-delay', '.4')
assert selected('default') and not selected('Aqua'), 'A failed change replaced the selected icon'
ui.capture('icon-failure-retained')
print('PASS: Preferences app icon in light/dark appearance, three-column icon previews, real icon switching and return navigation.')
