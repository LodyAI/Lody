"""Launch with --ui-verify --ui-verify-home --ui-verify-home-syncing first.
The fixture has a long workspace name. Status must stay at the screen centre,
leave with Home, and return after a Settings round trip.
"""
import sys
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])

def centred():
    items = ui.state()
    pill = next(i for i in items if i.get('AXUniqueId') == 'home-sync-status')
    screen, frame = items[0]['frame'], pill['frame']
    assert abs(frame['x'] + frame['width'] / 2 - (screen['x'] + screen['width'] / 2)) < 1, frame
    workspace = next(i for i in items if (i.get('AXLabel') or '').startswith(('切换工作区', 'Switch workspace')))
    assert workspace['frame']['width'] <= 60, workspace['frame']
    assert frame['width'] > 0 and frame['height'] > 0, frame

ui.element('home-sync-status')
centred()
ui.axe('tap', '--id', 'home-settings', '--post-delay', '.5')
assert not any(i.get('AXUniqueId') == 'home-sync-status' for i in ui.state())
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')
ui.element('home-sync-status')
centred()
print('PASS: status participates in the navigation bar and is screen-centred with a long workspace name, hides outside Home and returns centred')
