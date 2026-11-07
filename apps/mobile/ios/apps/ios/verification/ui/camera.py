"""Sheet camera UI with explicit offline capture outcomes; no physical-camera claim."""
import json
import subprocess
import sys
from pathlib import Path
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
source = 'create-session-input' if any(i.get('AXUniqueId') == 'create-session-input' for i in ui.state()) else 'session-input'

def tap(identifier):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.7')

def menu(key):
    tap('session-attach')
    ui.axe('tap', '--label', catalog.text('native.chat.composer.' + key), '--post-delay', '.8')

def captured():
    return [i for i in ui.state() if (i.get('AXUniqueId') or '').startswith('captured-photo:')]

def files():
    return set(container.joinpath('tmp').glob('*-Photo.jpg'))

def count(value):
    expected = catalog.text('native.chat.attachment.addCount.' + ('one' if value == 1 else 'other'), count=value)
    assert ui.element('attachment-confirm')['AXLabel'] == expected

container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
tap(source)
ui.type_into(source, 'Keep my camera draft')
ui.paste_file(source)
draft = ui.element(source)['AXValue']
original_attachments = [i['AXLabel'] for i in ui.state() if (i.get('AXLabel') or '').startswith('Remove ')]
assert original_attachments
menu('recentPhotos')
tile = ui.element('attachment-camera')['frame']
grid = ui.element('attachment-grid')['frame']
sheet = ui.element('attachment-sheet')['frame']
assert abs(sheet['width'] / sheet['height'] - .75) < .02, 'Recent-photo sheet must use a 3:4 viewport'
assert abs(grid['y'] + grid['height'] - sheet['y'] - sheet['height']) < 2, 'Grid stops above the sheet bottom safe area'
ui.capture('camera-tile')
events_path = container / 'tmp/lody-camera-events.json'
assert json.loads(events_path.read_text()) == ['start']
tap('attachment-camera')
expanded = ui.element('camera-expanded')['frame']
assert expanded['height'] > tile['height'] * 2, 'Camera did not expand beyond its thumbnail'
assert abs(expanded['y'] - sheet['y']) < 2 and abs(expanded['height'] - sheet['height']) < 2, 'Camera must fill the complete sheet, including safe areas'
shutter = ui.element('camera-shutter')['frame']
assert shutter['y'] + shutter['height'] < expanded['y'] + expanded['height'] - 20, 'Shutter overlaps the bottom gesture area'
for identifier in ('camera-collapse', 'camera-flash', 'camera-shutter', 'camera-flip', 'camera-library'):
    button = ui.element(identifier)
    frame = button['frame']
    assert abs(frame['width'] - frame['height']) < 1 and frame['width'] >= 44, f'{identifier} must have a circular, accessible touch target'
    assert button.get('AXLabel'), f'{identifier} lost its accessible name'
ui.capture('camera-expanded')
assert json.loads(events_path.read_text()) == ['start'], 'Expanding replaced or restarted the thumbnail session'
tap('camera-library')
ui.element('attachment-camera')
ui.capture('camera-collapsed')
tap('attachment-camera')
ui.axe('button', 'home')
ui.wait(lambda _: json.loads(events_path.read_text())[-1] == 'stop', 'Backgrounding did not stop camera ownership')
subprocess.run(['xcrun', 'simctl', 'launch', ui.udid, 'ai.lody.mobile'], check=True, timeout=30)
ui.element('camera-shutter')
ui.wait(lambda _: json.loads(events_path.read_text())[-1] == 'start', 'Foreground did not resume camera ownership')
# Camera failures are injected at the capture service boundary, followed by the real retry UI.
tap('camera-shutter')
assert ui.element('camera-status')['AXLabel'] == catalog.text('native.chat.camera.saveFailed')
ui.capture('camera-capture-error')
tap('camera-retry')
tap('camera-flash')
assert catalog.text('native.chat.camera.flash.on') in ui.element('camera-flash')['AXLabel']
tap('camera-flip')
before_capture = files()
tap('camera-shutter')
ui.element('camera-retake')
first = files() - before_capture
assert len(first) == 1, 'Confirmed capture did not persist exactly one image'
for identifier, key in (('camera-retake', 'retake'), ('camera-add', 'add')):
    button = ui.element(identifier)
    frame = button['frame']
    assert frame['height'] >= 44 and frame['width'] > frame['height'], 'Review actions must read as labelled pills'
    assert button.get('AXLabel') == catalog.text('native.chat.camera.' + key)
review_retake = ui.element('camera-retake')['frame']
review_add = ui.element('camera-add')['frame']
assert review_retake['x'] + review_retake['width'] < review_add['x'], 'Review actions overlap'
ui.capture('camera-review')
tap('camera-retake')
assert not any(p.exists() for p in first), 'Retake leaked its discarded image'
tap('camera-shutter')
tap('camera-add')
assert len(captured()) == 1
assert json.loads(events_path.read_text())[-1] == 'start', 'Returning to the visible camera tile did not resume preview ownership'
assert captured()[0].get('AXValue') == catalog.text('native.chat.attachment.selected')
count(1)
ui.capture('camera-selected')
# A second capture keeps the first selection. Deselecting/reselecting remains a grid action.
tap('attachment-camera')
tap('camera-shutter')
tap('camera-add')
assert len(captured()) == 2
count(2)
first_id = captured()[0]['AXUniqueId']
tap(first_id)
count(1)
tap(first_id)
count(2)
ui.capture('camera-two-selected')
tap('attachment-confirm')
assert ui.element(source)['AXValue'] == draft
for label in original_attachments:
    assert any(i.get('AXLabel') == label for i in ui.state()), 'Camera flow lost an existing attachment'
photo_label = catalog.text('native.chat.attachment.preview', name='Photo.jpg')
assert sum(i.get('AXLabel') == photo_label for i in ui.state()) == 2
ui.capture('camera-draft-retained')
# The menu camera is a full-screen controller, independent of the recent-photo grid.
menu('takePhoto')
full = ui.element('camera-fullscreen')['frame']
assert full['y'] < 2 and full['height'] > expanded['height'] * 1.5
assert not any(i.get('AXUniqueId') == 'attachment-grid' for i in ui.state())
viewfinder = ui.element('camera-viewfinder')['frame']
assert abs(viewfinder['width'] / viewfinder['height'] - .75) < .01
assert ui.element('camera-collapse')['frame']['y'] < viewfinder['y']
assert ui.element('camera-shutter')['frame']['y'] > viewfinder['y'] + viewfinder['height']
ui.capture('camera-direct-entry')
tap('camera-library')
# PHPicker is hosted by a system service and can omit its AX tree on Simulator.
# Its close button is the top-left control in the captured system picker.
ui.capture('camera-library')
ui.axe('tap', '-x', '38', '-y', '118', '--post-delay', '.8')
ui.element('camera-fullscreen')
tap('camera-shutter')
ui.element('camera-status')
tap('camera-retry')
before_cancel = files()
tap('camera-shutter')
ui.element('camera-retake')
discarded = files() - before_cancel
assert len(discarded) == 1
tap('camera-collapse')
assert not any(p.exists() for p in discarded), 'Closing a review leaked its discarded image'
ui.element(source)
assert ui.element(source)['AXValue'] == draft
assert sum(i.get('AXLabel') == photo_label for i in ui.state()) == 2
ui.capture('camera-cancel-retained')
# Confirming in the global camera returns straight to the draft with one new photo.
menu('takePhoto')
tap('camera-shutter')
tap('camera-retry')
tap('camera-shutter')
tap('camera-add')
ui.element(source)
assert ui.element(source)['AXValue'] == draft
assert sum(i.get('AXLabel') == photo_label for i in ui.state()) == 3
ui.capture('camera-direct-added')

assert json.loads(events_path.read_text())[-1] == 'stop', 'Dismissing the sheet left the camera active'
(ui.output / 'camera-lifecycle.json').write_text(events_path.read_text())
