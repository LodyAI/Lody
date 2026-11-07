"""Native Home settings entry, Debug return and nested remote/archived pages."""
import sys
import time
from driver import UI
import catalog
import settings_states

ui = UI(*sys.argv[1:])
workspace_name = '我的超长工作区名称不能折行'
avatar_label = catalog.workspace_switch(workspace_name)
def home_ready():
    ui.wait(lambda items: any(i.get('AXLabel') == avatar_label for i in items), 'Missing workspace avatar')
home_ready()

settings_label = catalog.text('tabs.settings')


def settings_button():
    return ui.wait(
        lambda items: next((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') == settings_label), None),
        'Missing settings button',
    )


def hold_settings():
    frame = settings_button()['frame']
    ui.axe(
        'touch',
        '-x', str(frame['x'] + frame['width'] / 2),
        '-y', str(frame['y'] + frame['height'] / 2),
        '--down', '--up', '--delay', '1.2',
    )
    time.sleep(1)


hold_settings()
ui.element('permission-native-preview')
assert not any(i.get('AXUniqueId') == 'account' for i in ui.state())
ui.capture('debug')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '1')
home_ready()
assert not any(i.get('AXUniqueId') == 'permission-native-preview' for i in ui.state())


def tap_sheet_back():
    # The inbox gear behind the sheet shares the Settings label; the back button is the leftmost.
    buttons = [i for i in ui.state() if i.get('type') == 'Button' and (i.get('AXUniqueId') == 'BackButton' or i.get('AXLabel') == settings_label)]
    frame = min(buttons, key=lambda i: i['frame']['x'])['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.5')


def reveal(identifier):
    for _ in range(4):
        items = ui.state()
        match = next((i for i in items if i.get('AXUniqueId') == identifier), None)
        if match and match['frame']['y'] + match['frame']['height'] < items[0]['frame']['height'] - 16:
            return match
        ui.axe('drag', '--start-x', '200', '--start-y', '700', '--end-x', '200', '--end-y', '400', '--duration', '.4', '--post-delay', '.5')
    raise AssertionError(f'Could not reach {identifier}')


ui.axe('tap', '--label', settings_label, '--post-delay', '1')
ui.element('account')
ui.capture('settings')
for kind in ('machine', 'agent', 'mcp'):
    row = ui.element(f'remote-{kind}')
    assert catalog.text(f'settings.remote.{kind}') in (row.get('AXLabel') or '')
    assert row['frame']['height'] >= 44
    ui.axe('tap', '--id', f'remote-{kind}', '--post-delay', '.5')
    settings_states.unavailable(ui, f'settings.unavailable.{kind}')
    ui.capture(f'remote-{kind}')
    tap_sheet_back()
    ui.element(f'remote-{kind}')
row = reveal('archived')
assert catalog.text('settings.archived.title') in (row.get('AXLabel') or '')
ui.axe('tap', '--id', 'archived', '--post-delay', '.8')
archived = ui.element('ui-search')
spoken = ' '.join((i.get('AXLabel') or '') for i in [archived, *(archived.get('children') or [])])
assert '搜索历史会话 Search' in spoken and catalog.text('inbox.badge.archived') in spoken, spoken
assert archived['frame']['height'] >= 44
ui.capture('archived-sessions')
tap_sheet_back()
ui.element('archived')
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=settings_label), '--post-delay', '1')
home_ready()
assert not any(i.get('AXUniqueId') == 'archived' for i in ui.state())
ui.capture('settings-closed')

print('PASS: Home enters Debug and Settings, pushes remote and archived pages, and closes to the inbox.')
