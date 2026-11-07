"""Production project-history settings: failed scan, partial import and explicit conflict replacement."""
import json
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])

def spoken(item):
    return ' '.join(str(item.get(key) or '') for key in ('AXLabel', 'AXValue')) + ' ' + ' '.join(spoken(child) for child in item.get('children') or [])

def tap(identifier):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.5')

def state(identifier, key):
    ui.wait(lambda items: any(item.get('AXUniqueId') == identifier and catalog.text(key) in spoken(item) for item in items), f'Missing {key} on {identifier}')

def button(key, **values):
    label = catalog.text(key, **values)
    return ui.wait(lambda items: next((item for item in items if item.get('AXLabel') == label and item.get('type') == 'Button'), None), f'Missing button {label}')

def toolbar():
    refresh = button('settings.history.sync')['frame']
    select = button('settings.history.selectAll')['frame']
    action = button('settings.history.import', count=0)
    first = ui.element('history-session:one')['frame']
    last = ui.element('history-session:done')['frame']
    assert refresh['y'] < first['y'], 'Refresh must be in navigation bar'
    assert select['y'] > last['y'] + last['height'], 'Selection toolbar must sit below content'
    assert action['frame']['x'] > select['x'] + select['width'], 'Import must trail Select All'
    assert not action['enabled'], 'Import without selection must be disabled'

def assert_no_empty():
    assert not any(catalog.text('settings.history.emptySessions') in spoken(item) for item in ui.state()), 'Loading/error incorrectly claims no conversations'

def loading():
    # One snapshot: the fixture scan lasts 4 s, about two describe-ui reads.
    sync = catalog.text('settings.history.sync')
    action = catalog.text('settings.history.import', count=0)
    def settled(items):
        loading = any(catalog.text('settings.history.loadingSessions') in spoken(item) for item in items)
        bars = all(any(item.get('AXLabel') == label and item.get('type') == 'Button' for item in items) for label in (sync, action))
        return items if loading and bars else None
    items = ui.wait(settled, 'Missing loading explanation with its bar items')
    assert not any(catalog.text('settings.history.emptySessions') in spoken(item) for item in items), 'Loading/error incorrectly claims no conversations'
    for label in (sync, action):
        assert not any(item.get('enabled') for item in items if item.get('AXLabel') == label and item.get('type') == 'Button'), f'{label} must be disabled while loading'
    ui.capture('loading')

ui.capture('projects')
projects = [item for item in ui.state() if str(item.get('AXUniqueId', '')).startswith('history-project:')]
assert len(projects) == 3, 'Each device/project must appear once regardless of agent count'
assert not any(str(item.get('AXUniqueId', '')).startswith('history-target:') for item in ui.state()), 'Agents must not be flattened into project list'
tap('history-project:["studio","demo"]')
target = ui.element('history-target:["studio","demo","builtin","codex"]')
ui.element('history-target:["studio","demo","builtin","grok"]')
assert len([item for item in ui.state() if str(item.get('AXUniqueId', '')).startswith('history-target:')]) == 2
ui.capture('agents')
tap(target['AXUniqueId'])
loading()
ui.wait(lambda items: any(catalog.text('settings.history.loadFailed') in spoken(item) for item in items), 'Missing scan failure')
assert_no_empty()
ui.capture('scan-failure')
ui.axe('tap', '--label', catalog.text('settings.history.sync'), '--post-delay', '.5')
loading()
ui.element('history-session:one')
toolbar()
ui.capture('sessions')
frame = button('settings.history.selectAll')['frame']
# Native bar-item AX frames describe content; exercise the surrounding 44 pt hit area.
ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2 - 21), '--post-delay', '.5')
button('settings.history.deselectAll')
ui.axe('tap', '--label', catalog.text('settings.history.deselectAll'), '--post-delay', '.5')
assert not button('settings.history.import', count=0)['enabled']
ui.axe('tap', '--label', catalog.text('settings.history.selectAll'), '--post-delay', '.5')
state('history-session:one', 'settings.history.selected')
state('history-session:two', 'settings.history.selected')
state('history-session:done', 'settings.history.imported')
assert button('settings.history.import', count=2)['enabled']
ui.capture('selected')
ui.axe('tap', '--label', catalog.text('settings.history.import', count=2), '--post-delay', '.5')
state('history-session:one', 'settings.history.imported')
state('history-session:two', 'settings.history.selected')
ui.capture('partial-import')
ui.axe('tap', '--label', catalog.text('settings.history.import', count=1), '--post-delay', '.5')
state('history-session:two', 'settings.history.imported')
ui.capture('retry-imported')
tap('history-session:conflict')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('settings.history.replaceTitle') for item in items), 'Missing destructive confirmation')
ui.capture('replace-confirmation')
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.5')
state('history-session:conflict', 'settings.history.conflict')
tap('history-session:conflict')
ui.axe('tap', '--label', catalog.text('settings.history.replace'), '--post-delay', '.5')
state('history-session:conflict', 'settings.history.imported')
assert not button('settings.history.import', count=0)['enabled']
assert not button('settings.history.selectAll')['enabled']
ui.capture('conflict-resolved')
ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '365', '--end-y', '450', '--duration', '.5', '--post-delay', '1')
ui.element(target['AXUniqueId'])
assert not any(item.get('AXLabel') == catalog.text('settings.history.selectAll') for item in ui.state()), 'Detail toolbar leaked into target list'
ui.capture('returned-agents')
tap('history-target:["studio","demo","builtin","grok"]')
loading()
ui.wait(lambda items: any(catalog.text('settings.history.emptySessions') in spoken(item) for item in items), 'Successful empty result must explain no conversations')
assert button('settings.history.sync')['enabled']
assert not button('settings.history.import', count=0)['enabled']
ui.capture('empty-result')
print(json.dumps({'partialImportRetainsSelection': True, 'completedImportPreserved': True, 'replacementRequiresConfirmation': True}))
