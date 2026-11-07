"""Native session outlines preserve navigation, collapsed state and orphan visibility."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def visible(identifier):
    return any(i.get('AXUniqueId') == identifier for i in ui.state())


def tap_row(identifier, disclosure=False):
    frame = ui.element(identifier)['frame']
    assert frame['height'] >= 44, frame
    x = frame['x'] + frame['width'] - 22 if disclosure else frame['x'] + min(130, frame['width'] / 2)
    ui.axe('tap', '-x', str(x), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.7')


def spoken(identifier):
    row = ui.element(identifier)
    return ' '.join(i.get('AXLabel') or '' for i in [row, *(row.get('children') or [])])


for identifier in ['tree-root', 'tree-check', 'tree-test', 'tree-grandchild', 'tree-other', 'tree-orphan']:
    ui.element(identifier)
ui.capture('expanded')
# A title tap opens the exact session, independently of its disclosure.
tap_row('tree-root')
ui.element('opened:tree-root')
ui.capture('parent-opened')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.7')
ui.element('tree-check')
tap_row('tree-root', disclosure=True)
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'tree-check' for i in items), 'Disclosure must collapse children without navigating')
assert visible('tree-other') and visible('tree-orphan')
assert '3 sessions' in spoken('tree-root')
assert catalog.text('inbox.badge.attention') in spoken('tree-root')
ui.capture('collapsed')
ui.axe('tap', '--label', 'Update tree', '--post-delay', '.7')
assert 'updated' in spoken('tree-root')
assert not visible('tree-check'), 'Catalog updates must retain the collapsed outline'
ui.capture('updated-collapsed')
# Project collapse/reopen must also retain a nested session's state.
tap_row('toggle:tree-project')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'tree-root' for i in items), 'Project must still collapse')
tap_row('toggle:tree-project')
ui.element('tree-root')
assert not visible('tree-check')
tap_row('tree-root', disclosure=True)
ui.element('tree-grandchild')
ui.capture('reexpanded')
tap_row('tree-test')
ui.element('opened:tree-test')
ui.capture('child-opened')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.7')
ui.element('tree-test')
ui.axe('tap', '--label', 'Toggle flat list', '--post-delay', '.7')
assert not visible('toggle:tree-project')
ui.element('tree-grandchild')
ui.capture('standalone-list')
tap_row('tree-root', disclosure=True)
assert not visible('tree-check')
ui.capture('standalone-collapsed')
ui.axe('tap', '--label', 'Filter tree', '--post-delay', '.7')
ui.element('tree-check')
assert not visible('tree-root'), 'A matching child remains visible when its opener is filtered out'
ui.capture('filtered-child')
tap_row('tree-check')
ui.element('opened:tree-check')
ui.capture('filtered-child-opened')
print('Two-level native outlines expand and collapse separately from navigation, retain collapsed state across catalog/project updates, surface waiting work, and keep filtered children reachable.')
