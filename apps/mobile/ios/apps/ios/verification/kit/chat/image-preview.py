"""Offline image fixture in Debug chat preview; run through pnpm verify:ui."""
import json
from pathlib import Path
import subprocess
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ui'))
import catalog

udid, output = sys.argv[1], Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)


def axe(*args):
    return subprocess.check_output(['axe', *args, '--udid', udid], text=True)


def elements():
    def walk(node):
        yield node
        for child in node.get('children', []):
            yield from walk(child)
    return [item for root in json.loads(axe('describe-ui')) for item in walk(root)]


def capture(name):
    subprocess.run(['xcrun', 'simctl', 'io', udid, 'screenshot', str(output / f'{name}.png')], check=True)


def title_state():
    items = elements()
    title = next(item for item in items if item.get('AXUniqueId') == 'chat-navigation-title')
    bars = [item for item in items if item.get('role_description') == 'Nav bar']
    assert not any(item.get('type') == 'StaticText' and 'lody-ios' in (item.get('AXLabel') or '')
                   for bar in bars for item in bar.get('children', [])), 'Duplicate system subtitle'
    return title['frame'], [(bar.get('AXUniqueId'), bar['frame']) for bar in bars]


initial_title = title_state()
items = elements()
height = items[0]['frame']['height']
IMAGE = catalog.text('native.chat.image.label', name='')
CLOSE = catalog.text('native.chat.image.closePreview')
source = next(item for item in items if (item.get('AXLabel') or '').startswith(IMAGE)
              and item['frame']['y'] > 100 and item['frame']['y'] + item['frame']['height'] < height - 110)
source_id = source['AXUniqueId']
assert source_id == 'preview-image:attachment:ui-verify-image', 'Use the offline image fixture'
name = source['AXLabel'].removeprefix(IMAGE)
axe('tap', '--id', source_id, '--post-delay', '1')
assert any(item.get('AXLabel') == CLOSE for item in elements()), 'Image must open the lightbox'
page_one_of_three = catalog.text('native.chat.image.page', current=1, total=3)
page_two_of_three = catalog.text('native.chat.image.page', current=2, total=3)
page_three_of_three = catalog.text('native.chat.image.page', current=3, total=3)
assert any(item.get('AXLabel') == page_one_of_three for item in elements()), 'A user turn with several photos must open as a gallery'
capture('opened')


def double_tap(label=None):
    target = label or name
    image = next(item for item in elements() if item.get('AXLabel') == target)
    frame = image['frame']
    x = max(20, min(items[0]['frame']['width'] / 2 if frame['width'] == 0 else frame['x'] + frame['width'] / 2, items[0]['frame']['width'] - 20))
    y = max(120, min(height - 100, frame['y'] + frame['height'] / 2))
    axe('batch', '--step', f'tap -x {x} -y {y}', '--step', 'sleep 0.08',
        '--step', f'tap -x {x} -y {y}')
    time.sleep(0.6)
    return next(item for item in elements() if item.get('AXLabel') == target)


zoomed = double_tap()
assert int(zoomed['AXValue'].rstrip('%')) > 100, 'Double tap must enlarge the image'
capture('zoomed')
assert double_tap()['AXValue'] == '100%', 'Second double tap must restore fit'
axe('tap', '--label', CLOSE, '--post-delay', '0.7')
assert not any(item.get('AXLabel') == CLOSE for item in elements())
assert any(item.get('AXUniqueId') == source_id for item in elements()), 'Closing must return to the message'
assert title_state() == initial_title, 'Preview return must preserve the two-line title geometry'
capture('closed')
axe('tap', '--id', source_id, '--post-delay', '1')
assert any(item.get('AXLabel') == CLOSE for item in elements())
# Explicit HID drag reliably delivers move events to UIKit's interactive transition.
axe('drag', '--start-x', str(items[0]['frame']['width'] / 2), '--start-y', str(height * 0.45),
    '--end-x', str(items[0]['frame']['width'] / 2), '--end-y', str(height * 0.85),
    '--duration', '0.6', '--post-delay', '2')
assert not any(item.get('AXLabel') == CLOSE for item in elements()), 'Drag must dismiss the preview'
assert any(item.get('AXUniqueId') == source_id for item in elements())
assert title_state() == initial_title, 'Gesture dismissal must preserve the two-line title geometry'
capture('drag-closed')
print(json.dumps({'open': True, 'doubleTapZoom': zoomed['AXValue'], 'restoreFit': True,
                  'returnToMessage': True, 'dragDismiss': True}))

axe('tap', '--id', source_id, '--post-delay', '1')
assert any(item.get('AXLabel') == CLOSE for item in elements())
width = items[0]['frame']['width']
axe('swipe', '--start-x', str(width * 0.8), '--start-y', str(height * 0.5),
    '--end-x', str(width * 0.2), '--end-y', str(height * 0.5), '--duration', '0.4', '--post-delay', '0.8')
assert any(item.get('AXLabel') == page_two_of_three for item in elements()), 'Swipe must reach the second photo in the message'
assert any(item.get('AXLabel') == 'two.png' for item in elements())
capture('album-paged')
axe('swipe', '--start-x', str(width * 0.8), '--start-y', str(height * 0.5),
    '--end-x', str(width * 0.2), '--end-y', str(height * 0.5), '--duration', '0.4', '--post-delay', '0.8')
assert any(item.get('AXLabel') == page_three_of_three for item in elements()), 'Swipe must reach the third photo in the message'
assert any(item.get('AXLabel') == 'three.png' for item in elements())
capture('album-last')
axe('tap', '--label', CLOSE, '--post-delay', '0.7')
assert any(item.get('AXUniqueId') == 'preview-image:attachment:ui-verify-image-2' for item in elements())
print(json.dumps({'userAlbum': 3, 'userAlbumPage': True}))

axe('tap', '--label', 'Fixtures')
axe('tap', '--label', 'MCP Image Fixture', '--post-delay', '1')
for index in range(2):
    image_id = f'preview-image:photo:image:{index}'
    assert any(item.get('AXUniqueId') == image_id for item in elements()), 'Every MCP image must stay inline'
capture('mcp-inline')
axe('tap', '--id', 'preview-image:photo:image:0', '--post-delay', '1')
assert any(item.get('AXLabel') == CLOSE for item in elements()), 'MCP image must open the lightbox'
page_one = catalog.text('native.chat.image.page', current=1, total=2)
page_two = catalog.text('native.chat.image.page', current=2, total=2)
assert any(item.get('AXLabel') == page_one for item in elements()), 'Gallery must start on the first image'
capture('mcp-opened')
width = items[0]['frame']['width']
axe('swipe', '--start-x', str(width * 0.8), '--start-y', str(height * 0.5),
    '--end-x', str(width * 0.2), '--end-y', str(height * 0.5), '--duration', '0.4', '--post-delay', '0.8')
opened = elements()
assert any(item.get('AXLabel') == page_two for item in opened), 'Swipe must show the second image'
assert any(item.get('AXLabel') == 'second.png' for item in opened)
capture('mcp-paged')
axe('tap', '--label', CLOSE, '--post-delay', '0.7')
assert any(item.get('AXUniqueId') == 'preview-image:photo:image:1' for item in elements()), 'Close must return to the current thumbnail'
assert title_state() == initial_title
capture('mcp-closed')

axe('tap', '--id', 'preview-image:photo:image:0', '--post-delay', '1')
assert any(item.get('AXLabel') == CLOSE for item in elements())
zoomed_gallery = double_tap('first.png')
assert int(zoomed_gallery['AXValue'].rstrip('%')) > 100
axe('swipe', '--start-x', str(width * 0.8), '--start-y', str(height * 0.5),
    '--end-x', str(width * 0.2), '--end-y', str(height * 0.5), '--duration', '0.4', '--post-delay', '0.8')
assert any(item.get('AXLabel') == page_one for item in elements()), 'A zoomed image must not page'
axe('tap', '--label', CLOSE, '--post-delay', '0.7')
print(json.dumps({'mcpImagesInline': 2, 'mcpPreview': True, 'mcpPage': True, 'mcpZoomBlocksPage': True, 'mcpReturn': True}))
