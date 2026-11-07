"""Record identical attachment-menu open, media/back and close interactions."""
import json
import subprocess
import sys
import time
from pathlib import Path
from driver import UI
from attachment_geometry import check_media_geometry

ui = UI(*sys.argv[1:])
field = 'session-input' if 'motion-chat' in str(ui.output) else 'create-session-input'

def center(identifier):
    f = ui.element(identifier)['frame']
    return (f['x'] + f['width']/2, f['y'] + f['height']/2)

def touch(point):
    ui.axe('tap', '-x', str(point[0]), '-y', str(point[1]), '--tap-style', 'physical', '--post-delay', '.8')

def tap(identifier):
    touch(center(identifier))

tap(field)
ui.type_into(field, 'Menu motion')
draft = ui.element(field).get('AXValue')
anchor = center('session-attach')
touch(anchor)
camera = center('attachment-menu-takePhoto')
photos = center('attachment-menu-recentPhotos')
# Warm the retained pages to separate transition motion from media loading.
touch(photos)
ui.element('attachment-photo-0')
photo_back = center('attachment-photos-back')
check_media_geometry(ui, 'attachment-photos-grid')
touch(photo_back)
touch(camera)
ui.element('camera-shutter')
camera_back = center('camera-collapse')
check_media_geometry(ui, 'camera-viewfinder')
touch(camera_back)
# Closing releases pages. The photo cache is warm for the recorded reopen.
outside = (200, 180)
touch(outside)
ui.capture('motion-ready')
events = []
for name, point, expected in [
    ('open', anchor, 'attachment-menu-takePhoto'),
    ('camera', camera, 'camera-shutter'),
    ('camera-back', camera_back, 'attachment-menu-takePhoto'),
    ('photos', photos, 'attachment-photo-0'),
    ('photos-back', photo_back, 'attachment-menu-takePhoto'),
    ('close', outside, None),
    ('reopen', anchor, 'attachment-menu-takePhoto'),
    ('close-again', outside, None),
]:
    started = time.time()
    touch(point)
    events.append({'action': name, 'start': started, 'end': time.time()})
    if expected:
        ui.element(expected)
    else:
        assert not any(i.get('AXUniqueId') == 'attachment-menu-takePhoto' for i in ui.state())
    if name in ['camera', 'photos', 'photos-back']:
        ui.capture(name)
(ui.output/'motion-events.json').write_text(json.dumps(events, indent=2))
assert ui.element(field).get('AXValue') == draft, 'Menu transitions changed the draft'
container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
frames = json.loads((Path(container)/'tmp/lody-camera-layout.json').read_text())
assert len(frames) > 2
assert max(f['width'] for f in frames) - min(f['width'] for f in frames) < .5
assert max(f['height'] for f in frames) - min(f['height'] for f in frames) < .5
ui.capture('motion-dismissed')
print('PASS: menu open/close, camera and photos/back, stable viewfinder and retained draft')
