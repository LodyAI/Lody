"""Native whole-workspace list -> current diff, refresh failure/retry/empty."""
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
ui.wait(lambda items: any('greeting.ts' in (i.get('AXLabel') or '') for i in items), 'Workspace files did not load')
for name in ['new-guide.md', 'removed.ts', 'image.png']:
    assert any(name in (i.get('AXLabel') or '') for i in ui.state()), name
assert ui.element('file:src/greeting.ts').get('AXValue') == '+1 −1', 'Change counts missing'
assert ui.element('file:docs/new-guide.md').get('AXValue') == '+12 −0', 'Added-file count missing'
ui.capture('workspace-files')
ui.axe('tap', '--id', 'file:src/greeting.ts')
ui.element('diff-render-ms')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'diff-toolbar-stats' and catalog.text('diff.base.current') in (i.get('AXLabel') or '') for i in items), 'Opened a turn diff instead of current diff')
ui.capture('current-diff')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'file:src/greeting.ts' and 'selected' not in str(i.get('traits') or []).lower() for i in items), 'File row stayed selected after return')
ui.axe('tap', '--label', catalog.text('workspaceChanges.refresh'))
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('workspaceChanges.error') for i in items), 'Refresh failure was hidden')
assert not any(i.get('AXLabel') == catalog.text('workspaceChanges.empty') for i in ui.state())
ui.capture('refresh-error')
ui.axe('tap', '--label', catalog.text('common.retry'))
ui.wait(lambda items: any('greeting.ts' in (i.get('AXLabel') or '') for i in items), 'Retry did not recover')
ui.capture('retry-recovered')
ui.axe('tap', '--label', catalog.text('workspaceChanges.refresh'))
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('workspaceChanges.empty') for i in items), 'Empty state missing')
ui.capture('empty-workspace')
print('PASS: native workspace list, current diff, failure, retry and empty workspace')
