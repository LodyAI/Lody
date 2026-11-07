"""The native creation form's project picker: local projects stay on their own segment,
even when GitHub has many repositories, and a pick returns to the form."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])

LOCAL = 'ui:local:alpha'
GITHUB_FIRST = 'github:Owner/Repo1'
GITHUB_LAST = 'github:Owner/Repo20'


def ids():
    return [item.get('AXUniqueId') or '' for item in ui.state()]


def visible(identifier):
    item = ui.element(identifier)
    frame = item['frame']
    return 80 <= frame['y'] <= 780


def tap_segment(index):
    frame = ui.element('list-segments')['frame']
    x = frame['x'] + frame['width'] * (0.25 if index == 0 else 0.75)
    y = frame['y'] + frame['height'] / 2
    ui.axe('tap', '-x', str(x), '-y', str(y), '--post-delay', '.6')


def search_field():
    return ui.element('list-search')


def type_search(text):
    field = search_field()
    frame = field['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.4')
    ui.axe('type', text)
    if catalog.LANGUAGE != 'en':
        ui.axe('key', '40')


def assert_local():
    ui.element(LOCAL)
    ui.element('ui:local:beta')
    assert visible(LOCAL), 'Local project must sit on the first screen'
    assert not any(item.startswith('github:') for item in ids()), (
        'GitHub repositories must not appear on the local segment'
    )


# Pinning is checked at full height; at the 0.62 detent a drag grows the sheet instead.
ui.axe('swipe', '--start-x', '201', '--start-y', '378', '--end-x', '201', '--end-y', '40', '--duration', '0.4', '--post-delay', '1.2')
ui.axe('tap', '--id', 'project', '--post-delay', '1')
ui.element('list-segments')
assert any(
    catalog.text('projectPicker.local') in (item.get('AXLabel') or '')
    for item in ui.state()
), 'Missing local segment label'
assert any(
    catalog.text('projectPicker.github') in (item.get('AXLabel') or '')
    for item in ui.state()
), 'Missing GitHub segment label'
assert_local()
search = search_field()
segments = ui.element('list-segments')
gap_above = search['frame']['y'] - (segments['frame']['y'] + segments['frame']['height'])
assert round(gap_above) >= 8, f'Search must sit below the segmented control, gap={gap_above}'
assert search['frame']['y'] < ui.element(LOCAL)['frame']['y'], 'Search must sit above the project list'
ui.capture('local')

type_search('Alpha')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'list-search' and (i.get('AXValue') or '').casefold() == 'alpha' for i in items), 'Project search lost input during filtering')
ui.axe('tap', '--label', 'x', '--pre-delay', '.5', '--post-delay', '.5')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'list-search' and (i.get('AXValue') or '').casefold() == 'alphax' for i in items), 'Project filtering lost input focus')
ui.axe('tap', '--id', 'delete', '--post-delay', '.5')
ui.element(LOCAL)
assert 'ui:local:beta' not in ids(), 'Search must hide local projects that do not match'
ui.capture('local-search')

tap_segment(1)
ui.wait(
    lambda items: any(item.get('AXUniqueId') == GITHUB_FIRST for item in items),
    'GitHub repositories did not appear after switching segment',
)
assert GITHUB_FIRST in ids()
assert LOCAL not in ids(), 'Local project must not appear on the GitHub segment'
assert 'Alpha' not in str(search_field().get('AXValue') or ''), (
    'GitHub search must not keep the local query'
)
ui.capture('github')

overlay_y = ui.element('list-strip')['frame']['y']
search_y = search_field()['frame']['y']
row = ui.element(GITHUB_FIRST)['frame']
ui.axe(
    'swipe',
    '--start-x', '200',
    '--start-y', str(int(row['y'] + row['height'] / 2)),
    '--end-x', '200',
    '--end-y', str(int(row['y'] + row['height'] / 2 - 220)),
    '--duration', '.6',
    '--post-delay', '.6',
)
assert abs(ui.element('list-strip')['frame']['y'] - overlay_y) < 2, (
    'Segments must stay pinned while the list scrolls'
)
search_after = next((i for i in ui.state() if i.get('AXUniqueId') == 'list-search'), None)
if search_after:
    assert search_after['frame']['y'] < search_y - 20, (
        f'Search must scroll with the list, before={search_y} after={search_after["frame"]["y"]}'
    )
ui.capture('edge-scrolled')

for _ in range(6):
    if GITHUB_LAST in ids():
        break
    ui.axe('swipe', '--start-x', '200', '--start-y', '700', '--end-x', '200', '--end-y', '240',
           '--duration', '.5', '--post-delay', '.5')
ui.element(GITHUB_LAST)
ui.capture('github-scrolled')

for _ in range(8):
    if any(
        i.get('AXUniqueId') == 'list-search' and i['frame']['y'] > overlay_y
        for i in ui.state()
        if i.get('frame')
    ):
        break
    ui.axe('swipe', '--start-x', '200', '--start-y', '280', '--end-x', '200', '--end-y', '620',
           '--duration', '.5', '--post-delay', '.5')
ui.element('list-search')

type_search('Repo20')
ui.wait(
    lambda items: any(item.get('AXUniqueId') == GITHUB_LAST for item in items),
    'GitHub search did not keep the matching repository',
)
assert GITHUB_FIRST not in ids(), 'GitHub search must hide repositories that do not match'
ui.capture('github-search')

tap_segment(0)
ui.element(LOCAL)
assert 'ui:local:beta' not in ids(), 'Local search must keep its own query after switching segments'
ui.capture('local-restored')

ui.axe('tap', '--id', LOCAL, '--post-delay', '1')
ui.element('create-session-input')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'project' and 'Alpha' in (i.get('AXLabel') or '') for i in items), 'Picked project missing from the form')
ui.axe('tap', '--id', 'project', '--post-delay', '1')
tap_segment(1)
ui.axe('tap', '--id', GITHUB_FIRST, '--post-delay', '1')
ui.element('branch')
ui.capture('github-picked')
