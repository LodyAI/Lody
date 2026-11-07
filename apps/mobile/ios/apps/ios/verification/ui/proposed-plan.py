"""Read, copy, stream and search a native proposed document without authorizing it."""
import subprocess
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
def tap(label):
    ui.wait(lambda items: any(i.get('AXLabel') == label and i.get('enabled', True) for i in items), f'Missing action: {label}')
    ui.axe('tap', '--label', label, '--post-delay', '.5')
def fixture(label):
    tap('Plan fixtures')
    tap(label)
def has(label):
    return any(i.get('AXLabel') == label for i in ui.state())
def document():
    return ui.element('plan-preview:document')
def reset():
    ui.open_case('proposed-plan-preview')
    document()

doc = document()
assert doc['frame']['height'] == 240
assert has('Expand plan') and not has('Review request')
controls = ui.state()
expand = next(i['frame'] for i in controls if i.get('AXLabel') == 'Expand plan')
copy = next(i['frame'] for i in controls if i.get('AXLabel') == 'Copy plan')
assert abs(expand['y'] - doc['frame']['y'] - doc['frame']['height']) < 1, 'Extra gap before expansion control'
assert copy['width'] >= 44 and copy['height'] >= 44, 'Copy target is too small'
ui.capture('collapsed')
tap('Copy plan')
clipboard = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True)
assert clipboard.startswith('# A clearer session list') and 'lighthouse' in clipboard
ui.capture('copied')
tap('Expand plan')
assert document()['frame']['height'] > 240
ui.capture('expanded')
for _ in range(4):
    button = next((i for i in ui.state() if i.get('AXLabel') == 'Collapse plan'), None)
    if button and 110 <= button['frame']['y'] < ui.element('session-input')['frame']['y'] - 44:
        break
    ui.axe('drag', '--start-x', '200', '--start-y', '580', '--end-x', '200', '--end-y', '260', '--duration', '.4', '--post-delay', '.5')
tap('Collapse plan')
assert document()['frame']['height'] == 240
ui.capture('collapsed-again')
tap('Expand plan')
# Native preview height stays bounded through deltas; expansion survives updates.
fixture('delta')
fixture('Append')
assert document()['frame']['height'] > 240
ui.capture('expanded-delta')
reset()
fixture('delta')
before = document()['frame']['height']
fixture('Append')
assert document()['frame']['height'] == before == 240
ui.capture('collapsed-delta')
fixture('long')
assert document()['frame']['height'] == 240
ui.capture('completed')
fixture('history')
assert has('Earlier plan') and not has('Review request')
ui.capture('history')
fixture('cleared')
assert not any(i.get('AXUniqueId') == 'plan-preview:document' for i in ui.state())
ui.capture('cleared')
fixture('short')
assert document()['frame']['height'] < 240
assert not has('Expand plan')
ui.capture('short')
fixture('approval')
tap('Review request')
ui.wait(lambda items: any(i.get('AXLabel') == 'Allow once' for i in items), 'Existing permission choices missing')
ui.capture('permission')
# Dismissing the permission sheet must never dispatch a response.
tap(catalog.text('accessibility.closeSheet', title=catalog.text('permission.title')))
tap('Plan fixtures')
assert has('Permission responses: 0')
ui.capture('fixture-menu')
tap('long')
ui.capture('permission-dismissed')
reset()
fixture('Find tail')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'plan-preview:document' and i['frame']['height'] > 240 for i in items), 'Search did not expand hidden plan prose')
ui.capture('search-tail')
assert ui.element('chat-find-count')['AXLabel'] == '1 / 1'
fixture('cleared')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'chat-find-count' and i.get('AXLabel') == catalog.text('native.chat.find.noResults') for i in items), 'Cleared plan remains searchable')
ui.capture('search-cleared')
ui.axe('tap', '--id', 'chat-find-close', '--post-delay', '.5')
fixture('long')
ui.capture('restored')
assert ui.element('session-input').get('AXValue') == 'Keep this draft'
print('PASS: native document expansion, complete copy, bounded streaming, history, clear, permission dismissal and search')

# The real decision hook sends through an injected recorder at the native service boundary.
reset()
fixture('business-ready')
assert has('Execute plan') and has('Continue discussing')
actions = {i.get('AXLabel'): i['frame'] for i in ui.state() if i.get('role') == 'AXButton' and i.get('AXLabel') in ['Execute plan', 'Continue discussing']}
execute, discuss = actions['Execute plan'], actions['Continue discussing']
assert abs(execute['y'] - discuss['y']) < 1, 'Plan actions must share one row'
assert discuss['x'] + discuss['width'] <= execute['x'], 'Execute must be rightmost without overlap'
assert min(execute['height'], discuss['height']) >= 44, 'Plan action targets are too small'
expand = next(i['frame'] for i in ui.state() if i.get('role') == 'AXButton' and i.get('AXLabel') == 'Expand plan')
assert abs(expand['y'] - execute['y']) < 1, 'Expand and actions must share one row'
assert expand['x'] + expand['width'] <= discuss['x'], 'Expand overlaps the action group'
ui.capture('business-ready')
tap('Expand plan')
assert not has('Collapse plan') and not has('Expand plan'), 'Expanded decision must leave the left side empty'
for _ in range(5):
    buttons = [i for i in ui.state() if i.get('role') == 'AXButton' and i.get('AXLabel') == 'Continue discussing']
    if buttons and 110 <= buttons[0]['frame']['y'] < ui.element('session-input')['frame']['y'] - 44:
        break
    ui.axe('drag', '--start-x', '200', '--start-y', '580', '--end-x', '200', '--end-y', '260', '--duration', '.4', '--post-delay', '.5')
expanded_actions = [i['frame'] for i in ui.state() if i.get('role') == 'AXButton' and i.get('AXLabel') == 'Continue discussing']
assert abs(expanded_actions[0]['x'] - discuss['x']) < 1, 'Expanded actions lost right alignment'
ui.capture('business-expanded')
tap('Continue discussing')
tap('Collapse plan')
assert not has('Execute plan')
tap('Plan fixtures')
assert has('Plan sends: 0 (valid)')
tap('business-busy')
assert not has('Execute plan')
fixture('business-ready')
tap('Execute plan')
ui.wait(lambda items: not any(i.get('AXLabel') in ['Execute plan', 'Sending…'] for i in items), 'Accepted plan decision did not dismiss')
assert ui.element('session-input').get('AXValue') == 'Keep this draft'
tap('Plan fixtures')
assert has('Plan sends: 1 (valid)'), 'Execution did not send the expected non-plan turn payload'
ui.capture('business-sent')
tap('business-failed')
tap('Execute plan')
ui.wait(lambda items: any(i.get('AXLabel') == 'The plan was not sent. Try again.' for i in items), 'Definite failure missing retry message')
ui.capture('business-failed')
tap('Execute plan')
ui.wait(lambda items: any(i.get('AXLabel') == 'Execute plan' and i.get('enabled') for i in items), 'Definite failure did not permit retry')
tap('Plan fixtures')
assert has('Plan sends: 2 (valid)')
tap('business-unknown')
tap('Execute plan')
ui.wait(lambda items: any(i.get('AXLabel') == 'Delivery is unconfirmed. Check the conversation before sending again.' for i in items), 'Unknown delivery missing feedback')
assert not next(i for i in ui.state() if i.get('AXLabel') == 'Execute plan').get('enabled', True)
assert ui.element('session-input').get('AXValue') == 'Keep this draft'
ui.capture('business-unknown')
print('PASS: plan execute/discuss, non-plan payload with model/permissions retained, draft preserved, definite retry and unknown-delivery fence')
