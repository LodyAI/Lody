"""Production composer overlay in both hosts; actual Simulator Photos fixture."""
import os
import sys
import subprocess
import time
from pathlib import Path
from driver import UI
from attachment_geometry import check_media_geometry
import catalog

ui = UI(*sys.argv[1:])
field = 'create-session-input' if 'sheet' in str(ui.output) else 'session-input'

def tap(identifier):
    f = ui.element(identifier)['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width']/2), '-y', str(f['y'] + f['height']/2),
           '--tap-style', 'physical', '--post-delay', '.6')

def choose_layout(value):
    title = catalog.text('native.chat.attachment.grid.' + value)
    if ui.element('attachment-photos-layout').get('AXValue') != title:
        tap('attachment-photos-layout')
    def settled(items):
        toggle = next((i for i in items if i.get('AXUniqueId') == 'attachment-photos-layout'), None)
        grid = next((i for i in items if i.get('AXUniqueId') == 'attachment-photos-grid'), None)
        screen = next((i for i in items if i.get('type') == 'Application'), None)
        if not toggle or not grid or not screen:
            return False
        width = screen['frame']['width'] - 24 - (24 if value == 'inset' else 0)
        return toggle.get('AXValue') == title and abs(grid['frame']['width']-width) < 1
    ui.wait(settled, 'Layout toggle and viewport did not settle')
    time.sleep(.4)

def keyboard():
    return ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar')), None), 'Keyboard missing')['frame']

def dismiss_keyboard_tip():
    # The managed runtime can show Apple's first-use slide-to-type tutorial
    # while still publishing the obscured keyboard keys in its AX tree.
    button = next((i for i in ui.state() if i.get('type') == 'Button'
                   and i.get('AXLabel') in ['Continue', '继续']
                   and i.get('frame', {}).get('y', 0) > 600), None)
    if button is None:
        return False
    ui.capture('keyboard-first-use-tip')
    f = button['frame']
    ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--tap-style', 'physical', '--post-delay', '.5')
    return True

tap(field)
keyboard_frame = keyboard()
dismiss_keyboard_tip()
ui.type_into(field, 'overlay draft\nsecond\nthird\nfourth')
time.sleep(1)
draft = ui.element(field).get('AXValue')
preview_prefix = catalog.text('native.chat.attachment.preview', name='')
initial_attachments = {i.get('AXLabel') for i in ui.state() if (i.get('AXLabel') or '').startswith(preview_prefix)}
assert draft and draft.count('\n') == 3, 'Multiline draft injection failed'
# Typing can add the prediction row; use the settled keyboard, not its entrance frame.
keyboard_frame = keyboard()
tap('session-attach')
menu_rows = [ui.element('attachment-menu-' + action)['frame'] for action in ['takePhoto', 'recentPhotos', 'files']]
ui.wait(lambda items: any((i.get('AXUniqueId') or '').startswith('attachment-menu-')
                          and i['frame']['y']+i['frame']['height'] > keyboard_frame['y'] for i in items),
        'Menu does not cover keyboard')
ui.capture('menu-over-keyboard')
tap('attachment-menu-recentPhotos')
ui.element('attachment-photos-access')
if ui.element('attachment-photos-layout').get('AXValue') != catalog.text('native.chat.attachment.grid.edgeToEdge'):
    choose_layout('edgeToEdge')
check_media_geometry(ui, 'attachment-photos-grid')
ui.capture('before-authorization')
tap('attachment-photos-access')
mode = os.environ.get('LODY_UI_PHOTO_ACCESS', 'full')
labels = {
    'full': ['Allow Full Access', 'Allow Access to All Photos', '允许完全访问', '允许访问所有照片'],
    'limited': ['Select Photos…', 'Select Photos...', 'Select Photos', 'Select Photos and Videos…', '选择照片…', '选择照片', '限制访问…', 'Limit Access…'],
    'denied': ["Don’t Allow", "Don't Allow", '不允许'],
    'settings': ["Don’t Allow", "Don't Allow", '不允许'],
}[mode]
permission = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') in labels), None), 'System Photos permission missing')
ui.capture('system-authorization')
f = permission['frame']
ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--tap-style', 'physical', '--post-delay', '.8')
if mode in ['denied', 'settings']:
    access = ui.element('attachment-photos-access')
    assert access.get('AXLabel') == catalog.text('native.chat.attachment.openSettings')
    assert access['frame']['y'] + access['frame']['height'] > keyboard_frame['y'], 'Denied page fell behind keyboard'
    assert ui.element(field).get('AXValue') == draft
    ui.capture('authorization-denied-returned')
    tap('attachment-photos-back')
    tap('attachment-menu-recentPhotos')
    ui.element('attachment-photos-access')
    ui.capture('denied-reopened')
    if mode == 'denied':
        print('PASS: denial restores recent photos above keyboard and keeps draft')
        raise SystemExit(0)
    tap('attachment-photos-access')
    # A fresh Simulator may open the Settings root for app-settings:. The
    # continuation only depends on leaving and returning, not its landing page.
    ui.wait(lambda items: not any(i.get('AXUniqueId') == field for i in items)
            and any(i.get('AXLabel') in ['Settings', '设置', 'Photos', '照片'] for i in items),
            'System Settings did not open')
    ui.capture('settings-opened')
    # Return without changing authorization: iOS may kill the app when privacy
    # changes, which is a cold launch rather than a live overlay continuation.
    subprocess.run(['xcrun','simctl','launch',ui.udid,'ai.lody.mobile'],check=True,timeout=30)
    access = ui.element('attachment-photos-access')
    assert access.get('AXLabel') == catalog.text('native.chat.attachment.openSettings')
    assert ui.element(field).get('AXValue') == draft
    assert access['frame']['y'] + access['frame']['height'] > keyboard_frame['y']
    ui.capture('settings-returned')
    print('PASS: Settings handoff returns to the same recent-photos page and draft')
    raise SystemExit(0)
if mode == 'limited':
    # iOS 26's remote limited-library picker does not expose its cells through
    # AXe. These physical positions were verified on the managed iPhone 17 Pro
    # fixture (402 x 874 pt); the app's returned grid verifies the selection.
    assert any(i.get('frame', {}).get('width') == 402 and i.get('frame', {}).get('height') == 874 for i in ui.state()), 'Limited picker requires the managed iPhone 17 Pro fixture'
    reader = ui.output / 'system-picker-text'
    subprocess.run(['xcrun', 'swiftc', str(Path(__file__).with_name('system-picker-text.swift')), '-o', str(reader)], check=True, timeout=60)
    image = ui.output / 'limited-picker-loading.png'
    deadline = time.monotonic() + 30
    while True:
        subprocess.run(['xcrun', 'simctl', 'io', ui.udid, 'screenshot', str(image)], check=True, capture_output=True, timeout=20)
        visible = subprocess.check_output([str(reader), str(image)], text=True, timeout=10)
        if 'Limited Access to Your Library' in visible:
            break
        assert time.monotonic() < deadline, 'System limited picker did not finish loading'
        time.sleep(.3)
    ui.capture('limited-system-picker')
    ui.axe('tap', '-x', '66', '-y', '369', '--tap-style', 'physical', '--post-delay', '.5')
    ui.capture('limited-system-selected')
    ui.axe('tap', '-x', '364', '-y', '144', '--tap-style', 'physical', '--post-delay', '.8')
ui.element('attachment-photo-0')
assert ui.element(field).get('AXValue') == draft, 'Authorization changed draft'
check_media_geometry(ui, 'attachment-photos-grid')
assert ui.element('attachment-photos-back')['frame']['height'] == 44
assert ui.element('attachment-photos-confirm')['frame']['height'] == 44
ui.capture('authorization-returned')
ui.capture('multiline-photos')

if mode == 'full':
    edge = ui.element('attachment-photos-grid')['frame']
    toggle = ui.element('attachment-photos-layout')['frame']
    confirm = ui.element('attachment-photos-confirm')['frame']
    assert toggle['height'] == 44 and toggle['width'] == 44
    assert 0 < confirm['x']-toggle['x']-toggle['width'] <= 8, 'Toggle must be adjacent to confirm'

    choose_layout('inset')
    inset = ui.element('attachment-photos-grid')['frame']
    gaps = [inset['x']-edge['x'], inset['y']-edge['y'],
            edge['x']+edge['width']-inset['x']-inset['width'],
            edge['y']+edge['height']-inset['y']-inset['height']]
    assert all(abs(gap-12) < 1 for gap in gaps), ('Insets must be 12pt on all four edges', gaps)
    ui.capture('layout-inset-equal-edges')
    # Destroy the entire page stack, then build a new one from the saved preference.
    tap('attachment-photos-back')
    ui.axe('tap', '-x', '200', '-y', '300', '--tap-style', 'physical', '--post-delay', '.6')
    tap('session-attach')
    tap('attachment-menu-recentPhotos')
    assert ui.element('attachment-photos-layout').get('AXValue') == catalog.text('native.chat.attachment.grid.inset'), 'Layout preference was lost'
    ui.capture('layout-preference-restored')
    choose_layout('edgeToEdge')
    check_media_geometry(ui, 'attachment-photos-grid')
    ui.capture('layout-edge-to-edge')
    # Reverse before the previous corner spring settles; keep the same panel
    # and verify its final layout before inspecting the recorded transition.
    toggle = ui.element('attachment-photos-layout')['frame']
    for _ in range(2):
        ui.axe('tap', '-x', str(toggle['x']+toggle['width']/2),
               '-y', str(toggle['y']+toggle['height']/2),
               '--tap-style', 'physical', '--post-delay', '.05')
    choose_layout('edgeToEdge')
    ui.capture('layout-corner-reversed')

    f = ui.element('attachment-photos-grid')['frame']
    ui.axe('swipe', '--start-x', str(f['x']+f['width']/2), '--start-y', str(f['y']+f['height']-110),
           '--end-x', str(f['x']+f['width']/2), '--end-y', str(f['y']+f['height']-260), '--duration', '1.2', '--post-delay', '1')
    visible = [i for i in ui.state() if (i.get('AXUniqueId') or '').startswith('attachment-photo-')
               and i['frame']['y'] < f['y']+f['height'] and i['frame']['y']+i['frame']['height'] > f['y']+1]
    anchor = min(visible, key=lambda i: (i['frame']['y'], i['frame']['x']))
    assert anchor['AXUniqueId'] != 'attachment-photo-0', 'Scroll fixture did not move'
    fraction = (f['y']-anchor['frame']['y'])/anchor['frame']['height']
    ui.capture('layout-scrolled-edge')
    choose_layout('inset')
    current = ui.element(anchor['AXUniqueId'])['frame']
    f = ui.element('attachment-photos-grid')['frame']
    assert abs((f['y']-current['y'])/current['height']-fraction) < .08, ('Switch lost the visible photo anchor', anchor, current, f, fraction)
    ui.capture('layout-scrolled-inset')
    choose_layout('edgeToEdge')
    for _ in range(2):
        ui.axe('swipe', '--start-x', str(f['x']+f['width']/2), '--start-y', str(f['y']+f['height']-110),
               '--end-x', str(f['x']+f['width']/2), '--end-y', str(f['y']+70), '--duration', '.5', '--post-delay', '.6')
    photos = [i for i in ui.state() if (i.get('AXUniqueId') or '').startswith('attachment-photo-')]
    last = max(photos, key=lambda i: int(i['AXUniqueId'].rsplit('-', 1)[1]))
    bottom = last['frame']['y'] + last['frame']['height']
    ui.capture('layout-bottom-edge')
    choose_layout('inset')
    last_frame = ui.element(last['AXUniqueId'])['frame']
    assert abs(last_frame['y']+last_frame['height']-bottom) < 2, 'Switch must stay pinned to the bottom'
    ui.capture('layout-bottom-inset')
    choose_layout('edgeToEdge')
    for _ in range(3):
        ui.axe('swipe', '--start-x', str(f['x']+f['width']/2), '--start-y', str(f['y']+70),
               '--end-x', str(f['x']+f['width']/2), '--end-y', str(f['y']+f['height']-110), '--duration', '.4', '--post-delay', '.5')
tap('attachment-photo-0')
assert ui.element('attachment-photos-confirm').get('AXValue') == '1'
ui.capture('single-selection-accent')
if mode == 'full':
    choose_layout('inset')
    assert ui.element('attachment-photos-confirm').get('AXValue') == '1'
    ui.capture('layout-inset-selected')
    choose_layout('edgeToEdge')
    assert ui.element('attachment-photos-confirm').get('AXValue') == '1'

tap('attachment-photo-0')
assert ui.element('attachment-photos-confirm').get('AXValue') == '0'
ui.capture('selection-cleared-neutral')
tap('attachment-photo-0')
tap('attachment-photos-back')
tap('attachment-menu-recentPhotos')
assert ui.element('attachment-photos-confirm').get('AXValue') == '1', 'Selection lost on back/forward'
ui.capture('retained-selection')
tap('attachment-photos-confirm')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'attachment-photos-back' for i in items), 'Overlay did not close')
assert ui.element(field).get('AXValue') == draft, 'Photo selection changed draft'
ui.wait(lambda items: any((i.get('AXLabel') or '').startswith(preview_prefix) and i.get('AXLabel') not in initial_attachments for i in items), 'Selected fixture not attached')
ui.capture('attachment-added')
assert any(i.get('AXLabel') == 'Requests: 0' for i in ui.state()), 'Photo import sent a message'
if mode == 'full':
    # Start with a visible destination for the multi-photo handoff too.
    remove_prefix = catalog.text('native.chat.attachment.remove', name='')
    for _ in range(4):
        remove = next((i for i in ui.state() if (i.get('AXLabel') or '').startswith(remove_prefix)), None)
        if remove is None:
            break
        f = remove['frame']
        ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--tap-style', 'physical', '--post-delay', '.3')
    assert not any((i.get('AXLabel') or '').startswith(preview_prefix) for i in ui.state())
    tap('session-attach')
    tap('attachment-menu-recentPhotos')
    tap('attachment-photo-0')
    tap('attachment-photo-1')
    assert ui.element('attachment-photos-confirm').get('AXValue') == '2'
    assert ui.element('attachment-photos-confirm')['frame']['height'] == 44
    ui.capture('multiple-selection-accent')
    tap('attachment-photos-confirm')
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'attachment-photos-back' for i in items), 'Multi-photo overlay did not close')
    ui.wait(lambda items: len([i for i in items if (i.get('AXLabel') or '').startswith(preview_prefix)]) == 2, 'Both selected photos must reach the draft')
    assert ui.element(field).get('AXValue') == draft
    assert any(i.get('AXLabel') == 'Requests: 0' for i in ui.state())
    ui.capture('multiple-attachments-added')
    print('PASS: single/multiple photo handoff, neutral/selected CTA states, no auto-send')
def type_key():
    key = ui.wait(lambda items: next((i for i in items if (i.get('AXLabel') or '').lower() == 'a' and i.get('type') == 'Button'), None), 'Keyboard no longer interactive')['frame']
    ui.axe('tap', '-x', str(key['x'] + key['width']/2), '-y', str(key['y'] + key['height']/2), '--tap-style', 'physical', '--post-delay', '.4')

dismiss_keyboard_tip()
type_key()
if ui.element(field).get('AXValue') == draft and dismiss_keyboard_tip():
    type_key()
assert ui.element(field).get('AXValue') == draft + 'a', 'Typing did not resume'
ui.capture('continued-editing')
print('PASS: authorization restores keyboard coverage, retained photo selection, real attachment import and draft editing')
# A keyboard-hidden presentation uses the same viewport as the multiline draft.
if 'chat' in str(ui.output):
    sheet_top = min([ui.element(field)['frame']['y']] + [i['frame']['y'] for i in ui.state()
                     if i.get('AXUniqueId') == 'session-grabber' and i['frame']['height'] > 0])
    ui.axe('tap', '-x', '200', '-y', str(min(300, sheet_top - 40)), '--tap-style', 'physical', '--post-delay', '.6')
    ui.wait(lambda items: not any((item.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar') for item in items), 'Keyboard did not dismiss')
    settled_draft = ui.element(field).get('AXValue')  # Blur commits keyboard autocorrection.
    tap('session-attach')
    tap('attachment-menu-recentPhotos')
    check_media_geometry(ui, 'attachment-photos-grid')
    assert ui.element(field).get('AXValue') == settled_draft
    ui.capture('keyboard-hidden-photos')
print('PASS: fixed media viewport with multiline draft and keyboard-hidden chat')
