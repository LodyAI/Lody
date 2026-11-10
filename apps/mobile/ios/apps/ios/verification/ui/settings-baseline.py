"""Settings grouping, reachable child pages, and workspace-scoped connection feedback."""
import json
import sys
import time
from driver import UI
import catalog
import flat_rows

ui = UI(sys.argv[1], sys.argv[2])
scenarios = ('live', 'signed-out', 'no-workspace', 'syncing', 'offline', 'cached')
observations = []


def identifiers(items):
    return {item.get('AXUniqueId') for item in items}


def reveal(identifier):
    for _ in range(6):
        items = ui.state()
        match = next((item for item in items if item.get('AXUniqueId') == identifier), None)
        if match:
            frame = match['frame']
            viewport = items[0]['frame']
            if frame['y'] + frame['height'] < viewport['y'] + viewport['height'] - 16:
                return match
        ui.axe('drag', '--start-x', '210', '--start-y', '720',
               '--end-x', '210', '--end-y', '360', '--duration', '.4', '--post-delay', '.3')
    raise AssertionError(f'Could not reach {identifier}')


def tap(identifier):
    node = reveal(identifier)
    assert node['frame']['height'] >= 44, node
    ui.axe('tap', '--id', identifier, '--post-delay', '.5')


def back():
    node = [item for item in ui.state() if item.get('AXUniqueId') == 'BackButton'][-1]
    frame = node['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.5')


def has_text(key):
    value = catalog.text(key)
    return any(value in (item.get('AXLabel') or '') for item in ui.state())


for index, scenario in enumerate(scenarios):
    started = time.monotonic()
    if index:
        ui.open_case(f'settings-baseline-{scenario}')
    ui.wait(lambda items: any(item.get('AXUniqueId') == 'settings-baseline-ready'
                             and item.get('AXLabel') == f'{scenario}:refreshes=0'
                             for item in items), f'Missing fixture state {scenario}')
    signed_in = scenario != 'signed-out'
    has_workspace = signed_in and scenario != 'no-workspace'
    account = ui.element('account')
    preferences = ui.element('preferences')
    assert account['frame']['y'] < preferences['frame']['y']
    expected_name = 'Settings Preview' if signed_in else catalog.text('settings.account.welcome')
    assert expected_name in account.get('AXLabel', ''), account
    assert account['frame']['height'] >= 44
    assert has_text('settings.section.personal')
    top = identifiers(ui.state())
    assert not {'appearance', 'remote-mcp', 'memory-settings', 'remote-machine'} & top
    assert not {'notifications', 'queued-message-behavior', 'accent-color', 'app-icon'} & top
    ui.capture(f'{scenario}-top')
    if scenario == 'live':
        flat_rows.assert_chat_rows(ui, 'live-chat-rows', 'remote-agent', 'agent-roles')
        flat_rows.assert_section_gap(ui, 'preferences', 'workspace-general')

    if scenario == 'live':
        tap('account')
        ui.element('logout')
        ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '65',
               '--end-y', '450', '--duration', '1', '--post-delay', '.6')
        ui.element('logout')
        ui.capture('account-pop-cancelled')
        back()
        ui.element('preferences')
        ui.capture('account-returned')

    if scenario == 'signed-out':
        # Only the moved entry seams are exercised; no chat or notification service flows.
        tap('preferences')
        original = ui.element('queued-message-behavior').get('AXValue')
        ui.capture('preferences-opened')
        tap('notifications')
        assert catalog.text('notifications.hint.signedOut') in ui.element('notification-permission')['AXLabel']
        back()
        assert ui.element('queued-message-behavior').get('AXValue') == original
        assert 'accent-color' not in identifiers(ui.state())
        ui.element('app-icon')
        ui.capture('preferences-app-icon')
        tap('app-icon')
        ui.element('app-icon-default')
        ui.capture('app-icons-opened')
        back()
        assert 'accent-color' not in identifiers(ui.state())
        ui.element('app-icon')
        back()
        tap('about')
        version = ui.element('app-version')
        assert 'Lody for iOS' in version['AXLabel']
        ui.capture('about-opened')
        flat_rows.assert_flat(ui, 'about-flat', 'app-version', 'licenses')
        tap('licenses')
        tap('Lody for iOS')
        ui.wait(lambda items: any('GNU AFFERO GENERAL PUBLIC LICENSE' in (item.get('AXLabel') or '')
                                 for item in items), 'Missing existing license detail')
        ui.capture('license-opened')
        back()
        back()
        ui.element('app-version')
        back()

    if has_workspace:
        for identifier in ('remote-agent', 'archived'):
            reveal(identifier)
        state = scenario if scenario in ('live', 'syncing') else 'offline'
        # Only an offline workspace has a footer; connected and syncing stay quiet.
        assert has_text('settings.connection.offline') == (state == 'offline'), f'Unexpected {state} workspace footer'
        visible = identifiers(ui.state())
        assert ('connection' in visible) == (state == 'offline')
        if scenario == 'cached':
            assert has_text('settings.connection.cached')
            ui.capture('cached-workspace')
            tap('connection')
            ui.wait(lambda items: any(item.get('AXUniqueId') == 'settings-baseline-ready'
                                     and item.get('AXLabel') == 'syncing:refreshes=1'
                                     for item in items), 'Resync missed refresh boundary')
            assert 'connection' not in identifiers(ui.state())
            assert not has_text('settings.connection.offline')
            ui.capture('cached-retry-syncing')
    elif signed_in:
        reveal('workspace-unavailable')
        assert has_text('settings.workspace.unavailableHint')

    reveal('debug-open')
    ui.element('diagnostics')
    ui.element('about')
    visible = identifiers(ui.state())
    assert not {'appearance', 'remote-mcp', 'memory-settings'} & visible
    assert not {'licenses', 'notifications', 'queued-message-behavior', 'accent-color', 'app-icon'} & visible
    if not has_workspace:
        assert not {'remote-machine', 'archived', 'connection'} & visible
    ui.capture(f'{scenario}-bottom')
    observations.append({'scenario': scenario, 'workspace': has_workspace,
                         'seconds': round(time.monotonic() - started, 2)})
    ui.axe('tap', '--label', 'Close Settings', '--post-delay', '.4')
    ui.wait(lambda items: 'settings-baseline-ready' not in identifiers(items), 'Fixture did not reset')

(ui.output / 'observations.json').write_text(json.dumps(observations, indent=2))
print('PASS: Settings grouping in six contexts, moved page entries/back, cached resync and native cancelled pop.')
