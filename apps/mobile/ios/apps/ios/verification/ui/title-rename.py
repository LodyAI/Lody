"""Renaming a session after load runs the first-line numericText transition through the native header path."""
import re
import sys
from driver import UI

ui = UI(*sys.argv[1:])

before = ui.element('chat-navigation-title')
assert 'main' in (before.get('AXLabel') or ''), 'Current branch missing: ' + str(before)
assert 'Updated session title' not in (before.get('AXLabel') or ''), before
assert not before.get('AXValue'), 'Title must not report a transition before any rename: ' + str(before)
ui.capture('before-rename')

ui.axe('tap', '--label', 'Fixtures')
ui.axe('tap', '--label', 'Rename Session', '--post-delay', '1.2')


def renamed(items):
    title = next((i for i in items if i.get('AXUniqueId') == 'chat-navigation-title'), None)
    if title and 'Updated session title' in (title.get('AXLabel') or '') and title.get('AXValue'):
        return title
    return None


title = ui.wait(renamed, 'Renamed title did not report its transition')
assert 'main' in (title.get('AXLabel') or ''), 'Rename lost the current branch: ' + str(title)
ui.capture('after-rename')
report = dict(re.findall(r'([a-z-]+):(\d+)', title['AXValue']))
assert int(report.get('sampled', 0)) >= 6, 'Probe sampled too few frames: ' + title['AXValue']
assert int(report.get('detached', 9)) <= 1, 'UIKit re-adds a reset titleView on the next layout; more detached ticks mean the restore was deferred: ' + title['AXValue']
assert int(report.get('transition-frames', 0)) >= 2, 'Rename did not animate the first line: ' + title['AXValue']
print('PASS: renamed title animated in place ' + title['AXValue'])
