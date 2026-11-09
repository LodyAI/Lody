"""Offline --ui-verify-home --ui-verify-sticky-groups, English.
iPhone Home has no tab bar: a floating new-chat button, Settings (with Schedules) from the header gear.
"""
import sys
from driver import UI
ui = UI(sys.argv[1], sys.argv[2])

def tap(label):
    ui.axe('tap', '--label', label, '--post-delay', '.6')

def drag(start, end):
    ui.axe('drag', '--start-x', '210', '--start-y', str(start), '--end-x', '210', '--end-y', str(end), '--duration', '.6', '--post-delay', '.6')

ui.element('home-chat-list')
assert not any(i.get('type') == 'RadioButton' for i in ui.state()), 'Home has no tab bar'
create = ui.element('home-new-session')['frame']
screen = next(i for i in ui.state() if i.get('type') == 'Application')['frame']
assert create['x'] + create['width'] > screen['width'] - 40 and create['y'] > screen['height'] - 140, create
ui.screenshot('home')
ui.axe('tap', '--id', 'home-settings', '--post-delay', '.6')
ui.element('schedules')
assert not any(i.get('AXUniqueId') == 'home-new-session' for i in ui.state()), 'Pushed pages cover the create button'
ui.axe('tap', '--id', 'schedules', '--post-delay', '.6')
ui.element('home-schedules-list')
tap('Back')
tap('Back')
ui.element('home-chat-list')
for _ in range(6):
    drag(300, 750)
    if any(i.get('AXLabel') == 'Conversation 1.1 — scrolling behind header' for i in ui.state()):
        break
header = ui.element('LodyKit.LodyPage')['frame']
tap('Conversation 1.1 — scrolling behind header')
ui.wait(lambda items: any(i.get('AXLabel') == 'Back' and i.get('type') == 'Button' for i in items), 'Detail must provide native Back')
tap('Back')
ui.element('home-chat-list')
returned = ui.element('LodyKit.LodyPage')['frame']
assert abs(returned['y'] - header['y']) < 2, ('No extra outer navigation bar after return', header, returned)
ui.screenshot('returned')
print('PASS: Home has no tab bar; floating create, Settings › Schedules and detail/back navigation')
