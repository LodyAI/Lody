"""Native activity page: workspace hop to the linked workspace, active-only rows, wrong-account and offline placeholders."""
import json
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
ACTIVE = ('activity-running', 'activity-waiting')
INACTIVE = ('activity-done', 'activity-archived')

ui.wait(lambda items: all(any(item.get('AXUniqueId') == identifier for item in items) for identifier in ACTIVE), 'Active sessions did not load after the workspace hop')
ids = {item.get('AXUniqueId') for item in ui.state()}
assert not ids.intersection(INACTIVE), f'Finished or archived sessions leaked into activity: {ids.intersection(INACTIVE)}'
assert any(catalog.text('inbox.settings.view.activity') == item.get('AXLabel') for item in ui.state()), 'Missing activity title'
ui.capture('activity')
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=catalog.text('inbox.settings.view.activity')), '--post-delay', '.5')
ui.wait(lambda items: not any(item.get('AXUniqueId') in ACTIVE for item in items), 'Activity sheet did not dismiss')

ui.open_case('activity-preview-wrong-account')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('notifications.route.wrongAccount') for item in items), 'Wrong account must explain itself')
assert not any(item.get('AXUniqueId') in ACTIVE for item in ui.state()), 'Another account saw this workspace activity'
ui.capture('wrong-account')

ui.open_case('activity-preview-offline')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('project.offline') for item in items), 'Offline activity must explain itself')
ui.capture('offline')
print(json.dumps({'workspaceHop': True, 'activeOnly': True, 'wrongAccount': True, 'offline': True}))
