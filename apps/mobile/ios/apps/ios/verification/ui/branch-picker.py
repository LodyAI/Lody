"""Offline production branch picker: defaults, paged search, selection and retry."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def tap(identifier):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.6')


def back():
    item = ui.wait(lambda items: max((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') in ['Back', catalog.text('create.title')]), key=lambda i: i['frame']['y'], default=None), 'Missing foreground Back')
    f = item['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.6')
    ui.element('create-session-input')


def pick_repo(number, first=False):
    tap('project')
    if first:
        f = ui.element('list-segments')['frame']
        ui.axe('tap', '-x', str(f['x'] + f['width'] * .75), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.6')
    tap(f'github:Owner/Repo{number}')
    ui.element('branch')


def selected(name):
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'branch' and name in str(i.get('AXLabel', '')) + str(i.get('AXValue', '')) for i in items), f'Base branch not {name}')


def search(value):
    f = ui.element('list-search')['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--tap-style', 'physical', '--post-delay', '.4')
    ui.axe('type', value)
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'list-search' and (i.get('AXValue') or '').casefold() == value.casefold() for i in items), 'Search lost characters during list refresh')
    ui.axe('tap', '--label', 'x', '--pre-delay', '.5', '--post-delay', '.5')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'list-search' and (i.get('AXValue') or '').casefold() == (value + 'x').casefold() for i in items), 'Search refresh lost input focus')
    ui.axe('tap', '--id', 'delete', '--post-delay', '.5')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'list-search' and (i.get('AXValue') or '').casefold() == value.casefold() for i in items), 'Search did not update after deleting a character')


ui.element('create-session-input')
ui.axe('swipe', '--start-x', '201', '--start-y', '378', '--end-x', '201', '--end-y', '40', '--duration', '.4', '--post-delay', '1.2')
pick_repo(1, first=True)
selected('main')
ui.capture('default-branch')
tap('branch')
ui.element('branch:main')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('create.branch.title') for i in items), 'Missing localized branch title')
assert ui.element('branch:main')['frame']['y'] < ui.element('branch:develop')['frame']['y'], 'Default branch must come first'
ui.capture('branch-list')
search('SEARCH-ACROSS')
ui.element('branch:feature/search-across-pages')
assert not any(i.get('AXUniqueId') == 'branch:main' for i in ui.state()), 'Search must filter unrelated branches'
ui.capture('paged-search')
tap('branch:feature/search-across-pages')
selected('feature/search-across-pages')
assert ui.element('branch')['frame']['height'] < 85, 'Branch value squeezed the field label into extra lines'
ui.capture('selected-branch')
tap('branch')
search('does-not-exist')
ui.element('branches-empty')
assert not any((i.get('AXUniqueId') or '').startswith('branch:') for i in ui.state()), 'No match must not offer an unverified branch'
ui.capture('no-results')
back()
selected('feature/search-across-pages')
tap('branch')
search('long-branch')
long = 'branch:feature/a-long-branch-name-that-wraps-without-hiding-the-important-part'
ui.element(long)
ui.capture('long-branch')
back()
selected('feature/search-across-pages')
# A new repository must not inherit the previous selection; failure offers retry.
pick_repo(2)
tap('branch')
ui.element('branches-more')
ui.wait(lambda items: any(catalog.text('create.branch.failed') in (i.get('AXLabel') or '') for i in items), 'Missing failed-load retry')
ui.capture('load-failed')
tap('branches-more')
ui.element('branch:trunk')
ui.capture('retry-default')
tap('branch:trunk')
selected('trunk')
pick_repo(3)
tap('branch')
ui.element('branches-empty')
ui.capture('empty-repository')
back()
assert 'trunk' not in str(ui.element('branch')), 'Empty repository inherited previous branch'
print('PASS: default selection, complete paged search, tap-to-select, cancellation, long names, retry and empty repository; no manual branch creation')
