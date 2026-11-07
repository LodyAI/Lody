"""PR/diff tap must offer destinations; tasks remain in the transcript only."""
import runpy
import sys
from pathlib import Path
from driver import UI

helpers = runpy.run_path(str(Path(__file__).with_name('action-capsules-review.py')), run_name='review')
ui, open_case = helpers['ui'], helpers['open_case']
open_case('crowded')
ui.capture('before-context-tap')
ui.axe('tap', '--id', 'session-bar:context', '--post-delay', '.7')
items = ui.state()
ui.capture('context-options')
assert not any(i.get('AXUniqueId') == 'pr-title' for i in items), 'Context tap jumped directly to PR details'
labels = [i.get('AXLabel') or '' for i in items]
assert any('变更' in label and '+285' in label and '35' in label for label in labels), labels
assert any('loro-dev/lody #128' in label for label in labels), labels
pr = next(i for i in items if 'loro-dev/lody #128' in (i.get('AXLabel') or '') and i.get('type') == 'Button')
f = pr['frame']
ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--post-delay', '.7')
ui.element('pr-title')
ui.capture('pr-selected')
open_case('crowded')
ui.axe('tap', '--id', 'session-bar:context', '--post-delay', '.5')
change = next(i for i in ui.state() if (i.get('AXLabel') or '').startswith('变更') and i.get('type') == 'Button')
f = change['frame']
ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--post-delay', '1.2')
ui.element('file:src/greeting.ts')
ui.capture('changes-selected')
open_case('tasks')
items = ui.state()
assert not any(i.get('AXUniqueId') == 'session-subtasks' for i in items), 'Task capsule remains'
assert any(i.get('AXUniqueId') == 'preview-answer:tasks' for i in items), 'Transcript tasks disappeared'
ui.capture('tasks-in-transcript')
open_case('conflict-ci')
ui.element('session-bar:more')
ui.axe('tap', '--id', 'session-bar:more', '--post-delay', '.5')
ui.capture('multiple-actions')
open_case('merge')
ui.capture('merge-disclosure')
print('PASS: context selection, PR destination, transcript-only tasks, multiple-action dropdown')
