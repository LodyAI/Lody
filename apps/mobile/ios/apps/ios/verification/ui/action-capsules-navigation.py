"""PR/diff tap must offer destinations; tasks remain in the transcript only."""
import subprocess
import sys
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])

def open_case(name):
    subprocess.run(['xcrun', 'simctl', 'launch', '--terminate-running-process', ui.udid,
                    'ai.lody.mobile', '--ui-verify', '--ui-review-bar=' + name,
                    '-AppleLanguages', '(en)', '-AppleLocale', 'en_US'], check=True, capture_output=True)
    ui.invalidate_axe()
    ui.element('session-input')
    ui.wait(lambda items: any('live' in str(i.get('AXValue')) for i in items
                            if i.get('AXUniqueId') == 'session-preview-probe'), 'Waiting for fixture')

for case in ('clean', 'local', 'long', 'repo'):
    open_case(case)
    ui.axe('tap', '--id', 'session-bar:context')
    expected = 'loro-dev/lody' if case == 'repo' else 'Current branch'
    items = ui.wait(lambda items: items if any((i.get('AXLabel') or '') == expected
                   for i in items) else None, 'Context header missing')
    labels = [i.get('AXLabel') or '' for i in items]
    if case != 'local':
        assert 'loro-dev/lody' in labels, labels
    if case == 'repo':
        assert 'Current branch' not in labels, labels
    else:
        copy = next(i for i in items if i.get('type') == 'Button' and (i.get('AXLabel') or '') == 'Copy Branch Name')
        assert copy['frame']['height'] >= 44, copy
    ui.capture('context-' + case)

open_case('crowded')
ui.capture('before-context-tap')
ui.axe('tap', '--id', 'session-bar:context', '--post-delay', '.7')
items = ui.state()
ui.capture('context-options')
assert not any(i.get('AXUniqueId') == 'pr-title' for i in items), 'Context tap jumped directly to PR details'
labels = [i.get('AXLabel') or '' for i in items]
assert any('All changes' in label and '+285' in label and '35' in label for label in labels), labels
assert any('View PR' in label and '#128' in label for label in labels), labels
pr = next(i for i in items if 'View PR' in (i.get('AXLabel') or '') and i.get('type') == 'Button')
f = pr['frame']
ui.axe('tap', '-x', str(f['x']+f['width']/2), '-y', str(f['y']+f['height']/2), '--post-delay', '.7')
ui.element('pr-title')
ui.capture('pr-selected')
open_case('crowded')
ui.axe('tap', '--id', 'session-bar:context', '--post-delay', '.5')
change = next(i for i in ui.state() if (i.get('AXLabel') or '').startswith('All changes') and i.get('type') == 'Button')
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
