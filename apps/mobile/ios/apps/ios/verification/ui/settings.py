"""Remote settings use production forms, with resettable failure outcomes at the service boundary."""
import json
import sys
from driver import UI
from sheet_background import capture_card
import catalog
import settings_states

ui = UI(sys.argv[1], sys.argv[2])
agents_only = '--agents-only' in sys.argv[3:]

def spoken(item):
    return ' '.join([str(item.get(key) or '') for key in ('AXLabel', 'AXValue')] + [spoken(child) for child in item.get('children') or []])

def label(identifier):
    return spoken(ui.element(identifier))

def reveal(identifier, up=False):
    for _ in range(12):
        items = ui.state()
        row = next((item for item in items if item.get('AXUniqueId') == identifier), None)
        if row and 125 <= row['frame']['y'] and row['frame']['y'] + row['frame']['height'] < items[0]['frame']['height'] - 40:
            return row
        start, end = ('320', '720') if up else ('720', '320')
        ui.axe('swipe', '--start-x', '180', '--start-y', start, '--end-x', '180', '--end-y', end, '--duration', '.4', '--post-delay', '.3')
    raise AssertionError(f'Could not reveal {identifier}')

def tap(identifier, up=False):
    reveal(identifier, up)
    ui.axe('tap', '--id', identifier, '--post-delay', '.5')

def show_text(text):
    for _ in range(12):
        if any(text in (item.get('AXLabel') or '') for item in ui.state()): return
        ui.axe('swipe', '--start-x', '180', '--start-y', '720', '--end-x', '180', '--end-y', '320', '--duration', '.4', '--post-delay', '.3')
    raise AssertionError(f'Missing {text}')

def back():
    frame = next(item['frame'] for item in reversed(ui.state()) if item.get('AXUniqueId') == 'BackButton')
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.6')

def toolbar(key):
    return ui.wait(lambda items: next((item for item in items if item.get('AXLabel') == catalog.text(key) and item.get('type') == 'Button'), None), f'Missing toolbar action {key}')

def save():
    # Saving is a native toolbar action, reachable while the keyboard is open.
    frame = toolbar('settings.remote.save')['frame']
    assert abs(frame['y'] - toolbar('common.cancel')['frame']['y']) < 10, 'Save must stay beside Cancel in the navigation bar'
    ui.axe('tap', '--label', catalog.text('settings.remote.save'), '--post-delay', '.5')

ui.capture('categories')
if not agents_only:
    ui.axe('tap', '--id', 'settings-machine', '--pre-delay', '.8', '--post-delay', '.8', '--tap-style', 'physical')
    settings_states.unavailable(ui, 'settings.unavailable.machine')
    settings_states.no_header_refresh(ui)
    ui.capture('load-failure')
    settings_states.try_again(ui)
    assert 'Studio Mac' in label('setting:machine::m1')
    assert catalog.text('devices.online') in label('setting:machine::m1')
    ui.capture('machines')
    tap('setting:machine::m1')
    assert toolbar('common.cancel')['frame']['x'] < toolbar('settings.remote.save')['frame']['x']
    ui.capture('machine-editor')
    tap('setting-name')
    ui.axe('type', ' mobile')
    machine_name = ui.element('setting-name')['AXValue']
    assert 'mobile' in machine_name
    save()
    ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting:machine::m1' and machine_name in (item.get('AXLabel') or '') for item in items), 'Machine rename did not reach list')
    ui.capture('machine-saved')

    back()
tap('settings-agent')
if agents_only:
    settings_states.unavailable(ui, 'settings.unavailable.agent')
    ui.capture('agent-load-failure')
    settings_states.try_again(ui)
ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting:agent:m1:a1' and 'Codex' in (item.get('AXLabel') or '') for item in items), 'Agent section did not open')
assert any((item.get('AXLabel') or '').startswith('Studio Mac') and catalog.text('devices.online') in (item.get('AXLabel') or '') for item in ui.state()), 'Missing machine group header with status'
assert 'Studio Mac' not in label('setting:agent:m1:a1'), 'Machine name should live in its group header'
ui.capture('agent-configurations')
reveal('usage:m1:codex:codex:0')
assert catalog.text('settings.usage.used', percent=32) in label('usage:m1:codex:codex:0')
assert catalog.text('settings.usage.onPace') in label('usage:m1:codex:codex:0')
reveal('usage:m1:codex:codex:1')
assert catalog.text('settings.usage.used', percent=61) in label('usage:m1:codex:codex:1')
ahead = catalog.text('settings.usage.ahead', percent=50, time='\0').split('\0')[0]
assert ahead in label('usage:m1:codex:codex:1'), 'Usage ahead of the window was not forecast'
reveal('usage:m1:codex:codex_bengalfox:0')
assert 'Spark' in label('usage:m1:codex:codex_bengalfox:0')
assert catalog.text('settings.usage.resetsUnknown') in label('usage:m1:codex:codex_bengalfox:0')
settings_states.no_header_refresh(ui)
ui.capture('agent-usage')
# A failed fetch on reconnect uses the persisted catalog-shaped projection.
reveal('usage:m1:codex:codex:0', up=True)
settings_states.pull(ui, 'usage:m1:codex:codex:0', settings_states.has_notice)
reveal('usage:m1:codex:codex:0', up=True)
assert catalog.text('settings.usage.used', percent=32) in label('usage:m1:codex:codex:0')
settings_states.notice(ui)
show_text(catalog.text('settings.usage.lastUnknown'))
ui.capture('agent-usage-offline')
reveal('usage:m1:codex:codex:0', up=True)
settings_states.pull(ui, 'usage:m1:codex:codex:0', lambda items: not settings_states.has_notice(items))
reveal('usage:m1:codex:codex:0', up=True)
ui.wait(lambda items: any(item.get('AXUniqueId') == 'usage:m1:codex:codex:0' and catalog.text('settings.usage.used', percent=72) in spoken(item) for item in items), 'Usage did not update after reconnect')
ui.capture('agent-usage-updated')
reveal('usage:m1:claude:claude:0')
assert catalog.text('settings.usage.used', percent=100) in label('usage:m1:claude:claude:0')
assert catalog.text('settings.usage.exhausted') in label('usage:m1:claude:claude:0')
assert not any((item.get('AXUniqueId') or '').startswith('usage:m1:kimi') for item in ui.state()), 'An eligible agent without quota data was drawn as a quota'
reveal('setting:agent:m1:a4')
assert 'Custom API' in label('setting:agent:m1:a4')
assert catalog.text('settings.usage.used', percent=0) not in label('setting:agent:m1:a4')
ui.capture('agent-usage-readonly-empty-api')
reveal('setting:agent:m2:a1')
assert not any('m2' == (item.get('AXLabel') or '').split(' ')[-1] for item in ui.state()), 'Raw machine ID is still shown'
ui.capture('agent-machine-groups')
tap('setting:agent:m2:a1', up=True)
assert ui.element('setting-prompt')['AXValue'] == 'Laptop instructions.'
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.5')
tap('setting:agent:m1:a2', up=True)
assert catalog.text('settings.remote.ownerOnly') in label('setting:agent:m1:a2')
assert not any(item.get('AXUniqueId') == 'setting-name' for item in ui.state()), 'Read-only Agent opened an editor'
tap('setting:agent:m1:a1', up=True)
capture_card(ui, 'agent-editor', 'setting-prompt')
tap('setting-prompt')
ui.axe('type', ' mobile instructions.')
prompt = ui.element('setting-prompt')['AXValue']
assert 'mobile instructions.' in prompt
save()
assert catalog.text('settings.remote.saveFailed') in label('lody.toast')
ui.capture('save-failure-toast')
assert ui.element('setting-prompt')['AXValue'] == prompt
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.5')
tap('setting:agent:m1:a1', up=True)
assert ui.element('setting-prompt')['AXValue'] == 'Keep changes focused.'
tap('setting-name')
ui.axe('type', ' Personal')
agent_name = ui.element('setting-name')['AXValue']
assert 'Personal' in agent_name
tap('setting-prompt')
ui.axe('type', ' mobile instructions.')
prompt = ui.element('setting-prompt')['AXValue']
save()
ui.element('setting:agent:m1:a1')
tap('setting:agent:m1:a1')
assert ui.element('setting-prompt')['AXValue'] == prompt
assert ui.element('setting-name')['AXValue'] == agent_name
ui.capture('agent-reopened')
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.5')
tap('setting:agent:m2:a1')
assert ui.element('setting-prompt')['AXValue'] == 'Laptop instructions.', 'Editing an agent changed an identically named config on another machine'
ui.capture('agent-machine-identity')
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.5')

if agents_only:
    print(json.dumps({'machineGroups': True, 'providerUsageSeparated': True, 'readonlyBlocked': True, 'failedSaveRetainedDraft': True, 'promptReadback': prompt}))
    sys.exit(0)

back()
tap('settings-mcp')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting:mcp::c1' and 'Documentation' in (item.get('AXLabel') or '') for item in items), 'MCP section did not open')
assert catalog.text('settings.mcp.defaultOff') in label('setting:mcp::c1')
tap('setting:mcp::c1')
ui.capture('mcp-editor')
toggle = ui.element('setting-enabled')['frame']
ui.axe('drag', '--start-x', str(toggle['x'] + 10), '--start-y', str(toggle['y'] + toggle['height'] / 2), '--end-x', str(toggle['x'] + toggle['width'] - 10), '--end-y', str(toggle['y'] + toggle['height'] / 2), '--duration', '.3', '--post-delay', '.5')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting-enabled' and item.get('AXValue') == '1' for item in items), 'MCP toggle did not turn on')
save()
ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting:mcp::c1' and catalog.text('settings.mcp.defaultOn') in spoken(item) for item in items), 'MCP default did not persist')
ui.capture('mcp-saved')
tap('setting:mcp::c1')
assert ui.element('setting-enabled').get('AXValue') == '1'
ui.capture('mcp-reopened')
print(json.dumps({'machineName': machine_name, 'agentPrompt': prompt, 'mcpEnabledByDefault': True, 'failuresRetainedDraft': True}))
