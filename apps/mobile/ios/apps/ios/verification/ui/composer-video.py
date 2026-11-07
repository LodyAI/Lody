"""A pasted video that also offers a PNG poster stays a file, not an image cell."""
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
pasted = ui.paste_video('session-input')
ui.capture('draft')
png = catalog.text('native.chat.attachment.preview', name='IMG_3933.png')
assert pasted != png, 'Video paste used the PNG poster name'
assert not any(item.get('AXLabel') == png for item in ui.state()), 'Video poster must not become the attachment chip'
image = catalog.text('native.chat.image.label', name='')
assert not any((item.get('AXLabel') or '').startswith(image) for item in ui.state()), 'Composer must not treat the video as an image'
name = 'IMG_3933.mp4' if pasted.endswith('IMG_3933.mp4') else 'IMG_3933.mov'
ui.axe('tap', '--id', 'session-send')

def sent_as_file(items):
    for item in items:
        uid = item.get('AXUniqueId') or ''
        label = item.get('AXLabel') or ''
        if (':attachment:' in uid) and name in label and not label.startswith(image):
            return True
    return False

ui.wait(sent_as_file, 'Sent video did not appear as a file name in the user row')
assert not any(
    (item.get('AXLabel') or '').startswith(image) for item in ui.state()
), 'Sent video must not appear as an image cell'
ui.capture('pending')
print('PASS: pasted video with a PNG poster stays a file attachment')
