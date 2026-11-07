"""Offline --ui-verify-home --ui-verify-sticky-groups: native sticky hand-off.
Run in English. Screenshots/video additionally verify the system material backdrop.
"""
import sys
from driver import UI
ui = UI(sys.argv[1], sys.argv[2])
ui.element('home-chat-list')

def label(name):
    matches = [i for i in ui.state() if i.get('AXLabel') == name and i.get('type') == 'Heading']
    assert len(matches) == 1, (name, matches)
    return matches[0]['frame']

def drag(distance):
    ui.axe('drag', '--start-x', '220', '--start-y', '700', '--end-x', '220',
           '--end-y', str(700-distance), '--duration', str(max(.15, min(2, abs(distance)/150))), '--post-delay', '.3')

# A relaunch may restore the previous list position; establish the fixture start.
for _ in range(6):
    if any((i.get('AXLabel') or '').startswith('Conversation 1.1 —') for i in ui.state()):
        break
    drag(-550)
drag(250)
first = label('Alpha project')
workspace = next(i for i in ui.state() if (i.get('AXLabel') or '').startswith(('Switch workspace', '切换工作区')))
workspace_bottom = workspace['frame']['y'] + workspace['frame']['height']
assert 0 <= first['y'] - workspace_bottom <= 16, ('Pinned label must sit close to the navigation controls', first, workspace['frame'])
drag(70)
assert abs(label('Alpha project')['y'] - first['y']) < 2, 'First header must stay pinned'
# Bring the second header to the same slot, crossing the push-off interval.
second = label('Beta project')
drag(min(550, round(second['y'] - first['y'] + 15)))
for _ in range(3):
    label('Beta project')
    drag(18)
second = label('Beta project')
assert abs(second['y'] - first['y']) < 2, (first, second)
# Visual regression: the departing title must blur behind the navigation area.
ui.screenshot("handoff")
for _ in range(5):
    drag(-100)
    if any(i.get('AXLabel') == 'Alpha project' and i.get('type') == 'Heading' for i in ui.state()):
        break
label('Alpha project')
label('Beta project')
ui.screenshot('return')
print('PASS: single native group labels pin, hand off, and return while reverse scrolling')
