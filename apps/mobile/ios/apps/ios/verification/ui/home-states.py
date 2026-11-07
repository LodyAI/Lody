"""The Design states workspace renders every rail row state on the production Home list."""
import subprocess
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
home_avatar = catalog.workspace_switch('我的超长工作区名称不能折行')
ui.wait(lambda items: any(i.get('AXLabel') == home_avatar for i in items), 'Missing workspace avatar')
ui.axe('tap', '--label', home_avatar, '--post-delay', '.8')
ui.axe('tap', '--label', 'Design states', '--post-delay', '1.2')

rows = ['st-checklist', 'st-review', 'st-ship', 'st-ship-mac', 'st-ship-fix', 'st-unread', 'st-sync']
for row in rows:
    ui.element(row)
review = ui.element('st-review')['frame']
child = ui.element('st-ship-mac')['frame']
assert child['height'] < review['height'], ('Sub-agent rows are one line', child, review)
assert abs(review['x']) <= 0.5, review


def gap_between(above, below):
    # Both frames come from one snapshot; a scroll still settling moves rows between reads.
    def frames(items):
        found = {i.get('AXUniqueId'): i['frame'] for i in items if i.get('AXUniqueId') in (above, below)}
        return found if len(found) == 2 else None
    found = ui.wait(frames, f'Missing {above} or {below}')
    upper = found[above]
    return found[below]['y'] - (upper['y'] + upper['height'])


group_gap = gap_between('st-checklist', 'toggle:states:lody-cloud')
project_gap = gap_between('st-bump', 'toggle:states:lody-ios')
# Bands mark every group, so groups only need one small step between them.
for name, gap in [('Pinned to projects', group_gap), ('project to project', project_gap)]:
    assert 6 <= gap <= 10, (f'{name} is one small step above the next band', gap)
ui.capture('states-top')


def rail_photo_pixels(identifier):
    row = ui.element(identifier)['frame']
    ui.screenshot('avatar-probe')
    width = round(ui.state()[0]['frame']['width'])
    pixels = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(ui.output / 'avatar-probe.png'), '-vf', f'scale={width}:-1',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], timeout=20)
    top = round(row['y'])
    # The fixture avatar is drawn in (124, 58, 237); no system glyph or row tint uses that violet.
    return sum(1 for y in range(top, top + round(row['height'])) for x in range(8, 44)
               if all(abs(pixels[(y * width + x) * 3 + c] - v) < 40 for c, v in enumerate((124, 58, 237))))


assert rail_photo_pixels('toggle:states:lody-ios') > 20, 'A project with an owner photo shows it on the rail'
assert rail_photo_pixels('toggle:states:lody-cloud') == 0, 'A project without a photo keeps the folder glyph'


def toggle_x(identifier):
    row = ui.element(identifier)['frame']
    ui.screenshot('children-probe')
    path = str(ui.output / 'children-probe.png')
    width = round(ui.state()[0]['frame']['width'])
    pixels = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', path, '-vf', f'scale={width}:-1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], timeout=20)
    line = round(row['y'] + row['height'] - 16)
    ground = pixels[line * width + 30]
    ink = [x for x in range(60, width - 16) if abs(pixels[line * width + x] - ground) > 40]
    assert ink, ('Line two must draw the sub-agent toggle', identifier)
    return max(ink) - 6, line


def tap_at(point):
    ui.axe('tap', '-x', str(point[0]), '-y', str(point[1]), '--post-delay', '.8')


# A folded parent takes its children's state and may show Review, so the open toggle is located once and reused.
fold_point = toggle_x('st-ship')
tap_at(fold_point)
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'st-ship-mac' for i in items), 'The line-two toggle folds the sub-agents')
assert any(i.get('AXUniqueId') == 'st-ship' for i in ui.state()), 'Folding keeps the parent session on screen'
ui.capture('states-folded')
tap_at(fold_point)
ui.element('st-ship-mac')
ui.axe('swipe', '--start-x', '200', '--start-y', '700', '--end-x', '200', '--end-y', '300', '--duration', '.4', '--post-delay', '.6')
for row in ['st-flaky', 'st-streams', 'st-notes']:
    ui.element(row)
chat_gap = gap_between('st-flaky', 'toggle:chat')
assert 6 <= chat_gap <= 10, ('Chat sits one small step below the projects', chat_gap)
ui.capture('states-bottom')

ui.axe('tap', '--id', 'magnifyingglass', '--post-delay', '.8')
ui.wait(ui.keyboard_ready, 'Search keyboard did not become visible')
ui.axe('type', 'watermark')
hit = ui.element('st-sync')
spoken = ' '.join([hit.get('AXLabel') or ''] + [child.get('AXLabel') or '' for child in hit.get('children') or []])
assert 'watermark' in spoken, ('A message match shows its snippet', spoken)
assert hit['frame']['height'] > 58, ('The snippet takes a second line', hit['frame'])
ui.capture('states-search')
print('PASS: the Design states workspace shows every rail state, folds sub-agents inline and highlights message search hits.')
