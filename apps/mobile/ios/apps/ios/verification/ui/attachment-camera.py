"""Production camera page with the app-owned deterministic capture fixture (no physical sensor)."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from driver import UI
from attachment_geometry import check_media_geometry
import catalog

ui = UI(*sys.argv[1:])
field = 'create-session-input' if 'sheet' in str(ui.output) else 'session-input'
def tap(identifier):
    f = ui.element(identifier)['frame']
    ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--tap-style', 'physical', '--post-delay', '.6')

def events():
    container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
    return json.loads((Path(container)/'tmp/lody-camera-events.json').read_text())

tap(field)
ui.type_into(field, 'camera draft')
draft = ui.element(field).get('AXValue')
assert draft and draft.casefold() == 'camera draft', 'Keyboard did not enter the fixture draft'
tap('session-attach')
for identifier in ['takePhoto', 'recentPhotos', 'files']:
    assert ui.element('attachment-menu-'+identifier)['frame']['height'] == 56
ui.capture('root-menu')
tap('attachment-menu-takePhoto')
mode = os.environ.get('LODY_UI_CAMERA_ACCESS', 'fixture')
if mode != 'fixture':
    labels = ['Allow', 'OK', '允许', '好'] if mode == 'allow' else ["Don’t Allow", "Don't Allow", '不允许']
    prompt = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') in labels), None), 'Camera authorization prompt missing')
    ui.capture('camera-system-permission')
    f = prompt['frame']
    ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--tap-style', 'physical', '--post-delay', '.8')
    ui.element('camera-collapse')
    if mode == 'deny':
        assert ui.element('camera-status').get('AXLabel') == catalog.text('native.chat.camera.denied')
    assert ui.element(field).get('AXValue') == draft
    keyboard = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar')), None), 'Keyboard missing')['frame']
    assert ui.element('camera-collapse')['frame']['y'] > keyboard['y'], 'Camera returned behind keyboard'
    check_media_geometry(ui, 'camera-viewfinder')
    ui.capture('camera-authorization-returned')
    tap('camera-collapse')
    tap('attachment-menu-takePhoto')
    ui.element('camera-collapse')
    if mode == 'deny':
        assert ui.element('camera-status').get('AXLabel') == catalog.text('native.chat.camera.denied')
    time.sleep(.8)  # Let the retained page's spring finish before visual evidence.
    ui.capture('camera-reopened')
    print('PASS: real camera permission returns above keyboard and preserves draft; Simulator has no camera sensor')
    raise SystemExit(0)
ui.element('camera-shutter')
check_media_geometry(ui, 'camera-viewfinder')
assert ui.element('camera-collapse')['frame']['height'] == 44
assert ui.element('camera-more')['frame']['height'] == 44
ui.capture('camera-expanded')
assert events()[-1] == 'start'
back_frame = ui.element('camera-collapse')['frame']
ui.axe('tap', '-x', str(back_frame['x'] + 1), '-y', str(back_frame['y'] + 22), '--tap-style', 'physical', '--post-delay', '.6')
ui.element('attachment-menu-takePhoto')
assert events()[-1] == 'stop', 'Back left the camera running'
container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
frames = json.loads((Path(container)/'tmp/lody-camera-layout.json').read_text())
(ui.output / 'viewfinder-layout.json').write_text(json.dumps(frames, indent=2))
assert len(frames) > 2, 'Camera transition geometry was not sampled'
assert max(f['width'] for f in frames) - min(f['width'] for f in frames) < .5, 'Viewfinder width scaled during opening'
assert max(f['height'] for f in frames) - min(f['height'] for f in frames) < .5, 'Viewfinder height scaled during opening'
assert max(f['visibleHeight'] for f in frames) - min(f['visibleHeight'] for f in frames) > 20, 'Fixture did not exercise a resizing panel'
ui.capture('camera-stable-preview-returned')
ui.capture('camera-back')
tap('attachment-menu-takePhoto')
tap('camera-more')
ui.capture('camera-options')
for identifier in ['camera-flip', 'camera-flash']:
    assert ui.element(identifier)['frame']['height'] == 44
assert ui.element('camera-flip')['frame']['y'] < ui.element('camera-more')['frame']['y']
assert ui.element('camera-flash')['frame']['y'] < ui.element('camera-flip')['frame']['y']
initial_flash = ui.element('camera-flash').get('AXValue')
tap('camera-flash')
assert ui.element('camera-flash').get('AXValue') != initial_flash
tap('camera-flip')
tap('camera-more')
assert not any(i.get('AXUniqueId') == 'camera-flip' for i in ui.state())
ui.capture('camera-options-closed')
tap('camera-shutter')
ui.element('camera-retry')
ui.capture('capture-failed')
tap('camera-retry')
tap('camera-shutter')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'camera-shutter' for i in items), 'Camera did not dismiss after capture')
assert not any(i.get('AXUniqueId') in ['camera-retake', 'camera-add'] for i in ui.state())
assert ui.element(field).get('AXValue') == draft
ui.wait(lambda items: any('Photo.jpg' in (i.get('AXLabel') or '') for i in items), 'Captured photo missing from composer')
assert events()[-1] == 'stop'
assert any(i.get('AXLabel') == 'Requests: 0' for i in ui.state()), 'Capture sent a message'
ui.capture('captured-photo-attached')
# Focus must survive handoff; type without tapping/re-focusing the input.
ui.axe('type', ' continues')
assert ui.element(field).get('AXValue') == draft + ' continues'
ui.capture('continued-typing')
# A new presentation gets a fresh page/session; outside dismissal must release it.
tap('session-attach')
tap('attachment-menu-takePhoto')
ui.element('camera-shutter')
ui.axe('tap', '-x', '200', '-y', '180', '--tap-style', 'physical', '--post-delay', '.8')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'camera-shutter' for i in items), 'Outside tap did not dismiss')
assert events()[-1] == 'stop', 'Dismiss left camera active'
ui.capture('camera-dismissed')
print('PASS: shared menu, camera back/reopen, inline tools, flash cycling, failure/retry, direct attach, dismissal and session shutdown')
# Scene deactivation releases capture too; foreground does not resurrect a dismissed panel.
tap('session-attach')
tap('attachment-menu-takePhoto')
ui.element('camera-shutter')
subprocess.run(['xcrun', 'simctl', 'launch', ui.udid, 'com.apple.Preferences'], check=True, timeout=30)
ui.wait(lambda items: not any(i.get('AXUniqueId') == field for i in items), 'App did not leave foreground')
assert events()[-1] == 'stop', 'Background left camera active'
subprocess.run(['xcrun', 'simctl', 'launch', ui.udid, 'ai.lody.mobile'], check=True, timeout=30)
assert ui.element(field).get('AXValue') == draft + ' continues'
assert not any(i.get('AXUniqueId') == 'camera-shutter' for i in ui.state())
assert any('Photo.jpg' in (i.get('AXLabel') or '') for i in ui.state()), 'Background lost the accepted photo'
ui.capture('foreground-restored')
print('PASS: background stops camera and foreground preserves draft without reopening overlay')
