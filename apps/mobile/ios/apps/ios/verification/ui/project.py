"""Native project page: active and archived groups, opened-session trees, the new-session bar item and row writes."""
import json
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def spoken(item):
    return ' '.join(str(item.get(key) or '') for key in ('AXLabel', 'AXValue')) + ' ' + ' '.join(spoken(child) for child in item.get('children') or [])


SESSIONS = ('project-live', 'project-child', 'project-unread', 'project-archived', 'project-chat')


def ids():
    rows = sorted((item['frame']['y'], item['AXUniqueId']) for item in ui.state() if item.get('AXUniqueId') in SESSIONS)
    return list(dict.fromkeys(identifier for _, identifier in rows))


ui.element('project-live')
ui.wait(lambda items: any(item.get('AXLabel') == 'Lody' for item in items), 'Project name must title the page')
new_session = catalog.text('project.newSession.accessibility')
ui.wait(lambda items: any(item.get('AXLabel') == new_session and item.get('type') == 'Button' for item in items), 'Missing new-session bar item')
rows = ids()
assert 'project-chat' not in rows, 'Sessions from other projects leaked into the page'
assert rows.index('project-live') < rows.index('project-unread') < rows.index('project-archived'), rows
assert any(catalog.text('session.state.archived') in spoken(item) for item in ui.state()), 'Missing archived group header'
assert 'project-child' not in rows or rows.index('project-child') == rows.index('project-live') + 1, 'Opened session must group under its opener'
ui.capture('project')

frame = ui.element('project-unread')['frame']
ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
archive = catalog.text('session.action.archive')
ui.wait(lambda items: any(item.get('AXLabel') == archive for item in items), 'Missing row menu')
ui.capture('row-menu')
ui.axe('tap', '--label', archive, '--post-delay', '.5')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'project-preview-writes' and 'archive:project-unread:true' in (item.get('AXValue') or '') for item in items), 'Archive did not reach the session write service')
rows = ids()
assert rows.index('project-unread') > rows.index('project-live'), rows
ui.capture('archived-moved')

ui.open_case('project-preview-empty')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('project.empty') for item in items), 'Empty project must explain itself')
ui.capture('empty')
ui.open_case('project-preview-offline')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('project.offline') for item in items), 'Offline project must explain itself')
ui.capture('offline')
print(json.dumps({'groups': True, 'tree': True, 'archiveWrite': True, 'empty': True, 'offline': True}))
