"""Exercise model memory through the production creation sheet and model page."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])

def tap_id(value):
    print('Tap:', value, flush=True)
    node = ui.element(value)
    if value == 'model':
        input_top = ui.element('create-session-input')['frame']['y']
        frame = node['frame']
        if frame['y'] + frame['height'] > input_top:
            start = input_top - 12
            ui.axe('swipe', '--start-x', '201', '--start-y', str(start),
                   '--end-x', '201', '--end-y', str(max(150, start - 160)), '--duration', '.4', '--post-delay', '.6')
            node = ui.element(value)
    if value.endswith(':toggle'):
        before = node.get('AXValue')
        ui.tap_switch(node)
        ui.wait(lambda items: any(i.get('AXUniqueId') == value and i.get('AXValue') != before for i in items), 'Model switch did not change')
        return
    frame = node['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.5')
    if value == 'create-session-input':
        ui.wait(lambda items: any((i.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar') and i['frame']['y'] < 800 for i in items), 'Software keyboard did not appear')

def tab(key):
    print('Tab:', key, flush=True)
    ui.axe('tap', '--label', catalog.text('model.tab.' + key), '--post-delay', '.5')

def back():
    # AX includes Debug's Back behind the sheet; use the foreground stack's button.
    item = ui.wait(lambda items: max((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') in ['Back', catalog.text('create.title')]), key=lambda i: i['frame']['y'], default=None), 'Back button missing')
    f = item['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width']/2), '-y', str(f['y'] + f['height']/2), '--post-delay', '.5')

def summary(value):
    print('Summary:', value, flush=True)
    ui.wait(lambda items: any(value in (i.get('AXLabel') or '') for i in items), 'Missing remembered summary: ' + value)

tap_id('model')
tap_id('a')
tab('effort')
tap_id('high')
tab('mode')
tap_id('read-only')
tab('model')
tap_id('b')
back()
summary('Model B · Full Access')
ui.capture('new-model-full-access')
tap_id('model')
tap_id('b')
tab('effort')
tap_id('low')
back()
summary('Model B · low · Full Access')
# The native composer must restore A's settings, not echo its temporary empty effort.
tap_id('create-session-input')
tap_id('session-model')
tap_id('composer-model-menu')
ui.axe('tap', '--label', 'Model A', '--element-type', 'Button', '--post-delay', '.8')
summary('High')
ui.capture('native-restored-a')
ui.axe('tap', '-x', '20', '-y', '160', '--post-delay', '.5')
summary('Model A · high · Read Only')
tap_id('model')
tap_id('b')
back()
summary('Model B · low · Full Access')
ui.capture('restored-b')

def pick_agent(agent):
    tap_id('agent')
    tap_id('ui:' + agent)

# Independent select and boolean options must preserve false, not just truthy values.
tap_id('model')
tab('more')
tap_id('fast-mode:toggle')
tap_id('config:collaboration_mode:plan')
ui.capture('codex-extra-options')
back()
summary(catalog.text('model.config.fast') + ': ' + catalog.text('model.config.on'))
tap_id('model')
tab('more')
tap_id('fast-mode:toggle')
back()
summary(catalog.text('model.config.fast') + ': ' + catalog.text('model.config.off'))
tap_id('model')
tap_id('a')
back()
summary('Model A · high · Read Only')
tap_id('model')
tap_id('b')
tab('more')
assert ui.element('fast-mode:toggle').get('AXValue') == '0'
tap_id('config:fast-mode:lody:default')
tap_id('config:collaboration_mode:lody:default')
back()
summary('Model B · low · Full Access')

# Grok's permission and interaction choices are independent, remembered per model.
pick_agent('grok')
tap_id('model')
tap_id('grok-a')
tab('effort')
tap_id('high')
tab('mode')
tap_id('plan')
tab('permission')
tap_id('config:permission_mode:always-approve')
ui.capture('grok-permission')
tab('model')
tap_id('grok-b')
tab('permission')
tap_id('config:permission_mode:auto')
back()
summary('Grok B · ' + catalog.text('model.permission.auto'))
tap_id('create-session-input')
tap_id('session-model')
tap_id('composer-model-menu')
ui.axe('tap', '--label', 'Grok A', '--element-type', 'Button', '--post-delay', '.8')
summary('High')
ui.axe('tap', '-x', '20', '-y', '160', '--post-delay', '.5')
summary('Grok A · high · Plan · ' + catalog.text('model.permission.alwaysApprove'))
ui.capture('grok-native-restored')

# A config-only effort ladder reaches the model page and native composer.
pick_agent('claude')
tap_id('model')
tab('effort')
tap_id('high')
tab('more')
tap_id('fast:toggle')
ui.capture('claude-extra-options')
back()
tap_id('create-session-input')
tap_id('session-model')
summary('High')
ui.capture('claude-native-effort')
ui.axe('tap', '-x', '20', '-y', '160', '--post-delay', '.5')
pick_agent('deepseek')
tap_id('model')
tab('more')
tap_id('config:agent_preset:coder')
ui.capture('agent-preset')
back()
summary('coder')
pick_agent('grok')
tap_id('model')
tap_id('grok-a')
back()
summary('Grok A · high · Plan · ' + catalog.text('model.permission.alwaysApprove'))
print('PASS: Grok permission, independent options, config-only effort, model/agent isolation, both selection hosts')
