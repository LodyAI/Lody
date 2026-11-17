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

# A prior interrupted run may leave this family folded in the existing list
# instance. Establish the starting state through the actual disclosure target.
parent = ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == 'st-ship'
                                     and i.get('AXValue')), None), 'Missing parent conversation')
if catalog.text('home.tree.collapsed') in parent['AXValue']:
    frame = parent['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] - 22), '--tap-style', 'physical')

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


# Project sections now follow their newest parent activity: iOS precedes Cloud.
# AX labels include their text position within the supplementary header. Keep
# sections visibly separated without mistaking text bounds for section bounds.
group_gap = gap_between('st-checklist', 'label:group:states:lody-ios')
assert 11 <= group_gap <= 32, ('Pinned and project sections remain separated', group_gap)
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




# The family button is hidden from AX (VoiceOver exposes a custom action on
# the parent). Its physical target is the bottom 44 points of the parent frame.
# Probe that contract directly, without locating text ink or invoking AX actions.
FAMILY_HEIGHT = 44
PARENT = 'st-ship'
CHILDREN = {'st-ship-mac', 'st-ship-fix'}


def family_frame(expanded):
    previous = None

    def ready(items):
        nonlocal previous
        state = catalog.text('home.tree.expanded' if expanded else 'home.tree.collapsed')
        parent = next((i for i in items if i.get('AXUniqueId') == PARENT
                       and state in (i.get('AXValue') or '')), None)
        visible = {i.get('AXUniqueId') for i in items}
        children_match = CHILDREN <= visible if expanded else CHILDREN.isdisjoint(visible)
        if not parent or not children_match or 'session-input' in visible:
            previous = None
            return None
        frame = parent['frame']
        geometry = tuple(frame[key] for key in ('x', 'y', 'width', 'height'))
        settled = previous is not None and all(abs(a - b) < .5 for a, b in zip(previous, geometry))
        previous = geometry
        return frame if settled else None

    frame = ui.wait(ready, f'Parent and both children did not settle with expanded={expanded}')
    assert frame['height'] > FAMILY_HEIGHT, ('Parent content must precede its family target', frame)
    return frame


def tap_at(point):
    ui.axe('tap', '-x', str(point[0]), '-y', str(point[1]), '--tap-style', 'physical')


def open_parent_above_family(expanded):
    frame = family_frame(expanded)
    # One point above the boundary is blank parent content, where the old
    # overlapping button stole the conversation tap.
    tap_at((frame['x'] + frame['width'] * .75,
            frame['y'] + frame['height'] - FAMILY_HEIGHT - 1))
    ui.element('session-input')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'chat-navigation-title'
                             and 'Ship 0.42 release' in (i.get('AXLabel') or '') for i in items),
            'The boundary tap did not open the parent conversation')
    ui.capture('states-parent-from-' + ('expanded' if expanded else 'collapsed'))
    ui.axe('tap', '--id', 'BackButton')
    family_frame(expanded)


open_parent_above_family(True)
# Blank space across the row must toggle, including near its top and bottom,
# not just the count/chevron. Every coordinate gets a collapse and an expand;
# fresh frames avoid assuming diffable updates leave the row in the same place.
for index, (fraction, offset) in enumerate(((.5, 2), (.75, 22), (.95, 42))):
    for expanded in (True, False):
        frame = family_frame(expanded)
        tap_at((frame['x'] + frame['width'] * fraction,
                frame['y'] + frame['height'] - FAMILY_HEIGHT + offset))
        family_frame(not expanded)
        if index == 0 and expanded:
            ui.capture('states-folded')
            open_parent_above_family(False)
ui.capture('states-expanded')
assert rail_photo_pixels('label:group:states:lody-ios') > 20, 'A project with an owner photo shows it in the heading'
ui.axe('drag', '--start-x', '200', '--start-y', '700', '--end-x', '200', '--end-y', '300', '--duration', '.4', '--post-delay', '.6')
for row in ['st-flaky', 'st-streams', 'st-notes']:
    ui.element(row)
project_gap = gap_between('st-flaky', 'label:group:states:lody-cloud')
chat_gap = gap_between('st-bump', 'label:group:chat')
for name, gap in [('iOS to Cloud', project_gap), ('Cloud to Chat', chat_gap)]:
    assert 11 <= gap <= 32, (f'{name} sections remain separated', gap)
assert rail_photo_pixels('label:group:states:lody-cloud') == 0, 'A project without an owner photo does not borrow another heading avatar'
ui.capture('states-bottom')

ui.axe('tap', '--id', 'magnifyingglass', '--post-delay', '.8')
ui.wait(ui.keyboard_ready, 'Search keyboard did not become visible')
ui.axe('type', 'watermark')
hit = ui.element('st-sync')
spoken = ' '.join([hit.get('AXLabel') or ''] + [child.get('AXLabel') or '' for child in hit.get('children') or []])
assert 'watermark' in spoken, ('A message match shows its snippet', spoken)
assert hit['frame']['height'] > 58, ('The snippet takes a second line', hit['frame'])
ui.capture('states-search')
print('PASS: the Design states workspace shows every rail state, keeps parent navigation separate from the full family touch target, toggles both children and highlights message search hits.')
