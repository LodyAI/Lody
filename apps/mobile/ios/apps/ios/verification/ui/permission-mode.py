"""Permission menu round trip and draft retention in each production composer host."""
import sys
from driver import UI

ui = UI(*sys.argv[1:])
create = 'permission-mode-create' in str(ui.output)
field = 'session-input' if 'permission-mode-chat' in str(ui.output) else 'create-session-input'
def tap(identifier):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.6')
def value(expected):
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'session-permission' and i.get('AXValue') == expected for i in items), 'Permission selection did not return to composer')
def select(label):
    item = ui.wait(lambda items: next((i for i in items if (i.get('AXLabel') or '').split(',')[0] == label and i.get('type') == 'Button'), None), 'Missing permission option: ' + label)
    frame = item['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width']/2), '-y', str(frame['y'] + frame['height']/2), '--post-delay', '.6')

tap(field)
ui.type_into(field, 'Keep this permission draft')
button = ui.element('session-permission')['frame']
assert button['width'] >= 44 and button['height'] >= 44
model = ui.element('session-model')['frame']
assert model['x'] >= button['x'] + button['width'], 'Permission overlaps model'
mentions = [i for i in ui.state() if i.get('AXUniqueId') == 'session-mention']
if not create:
    assert mentions, 'Mention control missing from permission fixture'
if not create:
    assert button['x'] >= mentions[0]['frame']['x'] + mentions[0]['frame']['width'], 'Permission overlaps mentions'
initial = 'Full Access' if create else 'Ask Every Time'
selected = 'Read Only' if create else 'Auto Approve'
value(initial)
ui.capture('before-menu')
tap('session-permission')
ui.capture('menu')
select(selected)
value(selected)
assert 'permission draft' in ui.element(field).get('AXValue', '').lower()
ui.capture('selected')
# Reopening must retain the selected mode. Model controls must not reset it.
tap('session-model')
ui.element('composer-model-menu')
ui.axe('tap', '-x', '20', '-y', '160', '--post-delay', '.6')
value(selected)
tap('session-permission')
ui.capture('reopened')
select(initial)
value(initial)
assert 'permission draft' in ui.element(field).get('AXValue', '').lower()
ui.capture('restored')
if create:
    tap('agent')
    tap('ui:grok')
    tap(field)
    value('ask')
    tap('session-permission')
    ui.capture('explicit-permission-menu')
    select('always-approve')
    value('always-approve')
    tap('agent')
    tap('ui:claude')
    tap(field)
    # AXe can include UIKit's hidden views; exercise the former hit target
    # and verify it cannot reopen the old agent's menu. Inspect this capture too.
    ui.axe('tap', '-x', str(button['x'] + button['width']/2), '-y', str(button['y'] + button['height']/2), '--post-delay', '.6')
    assert not any((i.get('AXLabel') or '') == 'always-approve' for i in ui.state()), 'Unsupported agent retained actionable permission menu'
    ui.capture('unsupported-agent')
    tap('agent')
    tap('ui:grok')
    tap(field)
    value('always-approve')
    assert 'permission draft' in ui.element(field).get('AXValue', '').lower()
    ui.capture('agent-restored')
print('PASS: permission choices, 44 pt target, no overlap, host round trip and retained draft')
