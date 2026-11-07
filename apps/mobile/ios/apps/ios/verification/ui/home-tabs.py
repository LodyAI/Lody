"""Offline --ui-verify-home --ui-verify-sticky-groups, English.
Capture video alongside this check to review UIKit's intermediate tab geometry.
"""
import sys
from driver import UI
ui = UI(sys.argv[1], sys.argv[2])

def tab(label):
    return ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == label and i.get('type') == 'RadioButton'), None), 'Missing tab ' + label)

def tap(label):
    ui.axe('tap', '--label', label, '--post-delay', '.6')

def drag(start, end):
    ui.axe('drag', '--start-x', '210', '--start-y', str(start), '--end-x', '210', '--end-y', str(end), '--duration', '.6', '--post-delay', '.6')

ui.element('home-chat-list')
expanded = tab('Chats')['frame']
assert expanded['width'] > 80
ui.screenshot('expanded')
drag(700, 250)
compact = tab('Chats')['frame']
assert compact['width'] < expanded['width'] * .8, (expanded, compact)
ui.screenshot('compact')
tap('Chats')  # Native minimized tab expands on tap.
assert tab('Projects')['frame']['width'] > 80
tap('Projects')
assert tab('Projects')['AXValue'] == 1
tap('Settings')
assert tab('Settings')['AXValue'] == 1
tap('Chats')
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
assert tab('Chats')['AXValue'] == 1
ui.screenshot('returned')
print('PASS: native tabs minimize, expand, switch, and preserve detail/back navigation')
