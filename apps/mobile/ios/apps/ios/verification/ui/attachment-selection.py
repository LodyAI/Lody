"""Photo resizing and selection in all composer hosts with an authorized local library."""
import sys
from driver import UI
from attachment_geometry import check_media_geometry
import catalog

ui = UI(*sys.argv[1:])
field = 'create-session-input' if any(host in str(ui.output) for host in ['sheet', 'create']) else 'session-input'


def tap(identifier):
    f = ui.element(identifier)['frame']
    y = f['y'] + f['height']/2
    if identifier.startswith('attachment-photo-'):
        grid = ui.element('attachment-photos-grid')['frame']
        y = (max(f['y'], grid['y']) + min(f['y']+f['height'], grid['y']+grid['height'])) / 2
    ui.axe('tap', '-x', str(f['x'] + f['width']/2), '-y', str(y),
           '--tap-style', 'physical', '--post-delay', '.6')


def layout(mode):
    title = catalog.text('native.chat.attachment.grid.' + mode)
    if ui.element('attachment-photos-layout').get('AXValue') != title:
        tap('attachment-photos-layout')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'attachment-photos-layout'
                             and i.get('AXValue') == title for i in items), 'Photo layout did not change')


def count(expected):
    assert ui.element('attachment-photos-confirm').get('AXValue') == str(expected)


tap(field)
ui.type_into(field, 'Photo selection draft')
draft = ui.element(field).get('AXValue')
assert draft and draft.casefold() == 'photo selection draft'
prefix = catalog.text('native.chat.attachment.preview', name='')
initial_attachments = {i.get('AXLabel') for i in ui.state() if (i.get('AXLabel') or '').startswith(prefix)}
tap('session-attach')
tap('attachment-menu-recentPhotos')
ui.element('attachment-photo-0')
layout('edgeToEdge')
check_media_geometry(ui, 'attachment-photos-grid')
# Neutral actions must retain white content over a locally dimmed clear-glass backing.
ui.capture('neutral-glass-actions')
tap('attachment-photo-0')
tap('attachment-photo-2')
count(2)
ui.capture('selected-top-corners-white-numbers')
# Exercise repeated resizing while selected; native checks guard cell identity
# during the transition, and this recording covers the production overlay hosts.
for _ in range(2):
    for mode in ['inset', 'edgeToEdge']:
        layout(mode)
        count(2)
        fourth_row = [ui.element('attachment-photo-' + str(i))['frame'] for i in [9, 10, 11]]
        assert max(rect['y'] for rect in fourth_row) - min(rect['y'] for rect in fourth_row) < 1
        assert fourth_row[0]['x'] < fourth_row[1]['x'] < fourth_row[2]['x']
ui.capture('selected-after-repeated-resizing')
tap('attachment-photo-0')
tap('attachment-photo-2')
count(0)
f = ui.element('attachment-photos-grid')['frame']

def visible_photos(items):
    return [i for i in items if (i.get('AXUniqueId') or '').startswith('attachment-photo-')
            and i['frame']['y'] < f['y'] + f['height']
            and i['frame']['y'] + i['frame']['height'] > f['y']]

before = {i['AXUniqueId']: i['frame']['y'] for i in visible_photos(ui.state())}
ui.axe('swipe', '--start-x', str(f['x']+f['width']/2), '--start-y', str(f['y']+f['height']-110),
       '--end-x', str(f['x']+f['width']/2), '--end-y', str(f['y']+f['height']-260),
       '--duration', '1.2', '--delta', '2', '--post-delay', '.6')
def moved(items):
    photos = visible_photos(items)
    if any(i['AXUniqueId'] not in before or abs(i['frame']['y']-before[i['AXUniqueId']]) > 5 for i in photos):
        return photos
    return None
photos = ui.wait(moved, 'Photo grid did not scroll')
top = min(i['frame']['y'] for i in photos)
row = sorted([i for i in photos if abs(i['frame']['y']-top) < 1], key=lambda i: i['frame']['x'])
assert len(row) == 3, 'Scrolled grid must expose a three-photo top row'
for item in [row[0], row[-1]]:
    rect = item['frame']
    y = (max(f['y'], rect['y']) + min(f['y']+f['height'], rect['y']+rect['height'])) / 2
    ui.axe('tap', '-x', str(rect['x']+rect['width']/2), '-y', str(y), '--tap-style', 'physical', '--post-delay', '.6')
count(2)
ui.capture('selected-corners-partially-scrolled')
layout('inset')
count(2)
ui.capture('selected-inset-scrolled')
layout('edgeToEdge')
tap(row[0]['AXUniqueId'])
count(1)
ui.capture('selection-renumbered')
tap('attachment-photos-confirm')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'attachment-photos-confirm' for i in items), 'Selection did not close')
assert ui.element(field).get('AXValue') == draft, 'Photo import changed the draft'
ui.wait(lambda items: any((i.get('AXLabel') or '').startswith(prefix) and i.get('AXLabel') not in initial_attachments for i in items), 'Selected photo did not reach the draft')
ui.capture('selected-photo-attached')
print('PASS: repeated edge/inset resizing, retained selection, both top corners, partial scroll, renumbering and draft-preserving import')
