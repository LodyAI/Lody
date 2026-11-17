"""Provider management uses production pages with a deterministic service boundary."""
import sys
import subprocess
from driver import UI
import catalog
import settings_states

ui = UI(sys.argv[1], sys.argv[2])


def visible(identifier):
    for _ in range(8):
        items = ui.state()
        row = next((i for i in items if i.get('AXUniqueId') == identifier), None)
        height = items[0]['frame']['height']
        keyboard = ui.visible_keyboard(items)
        bottom = keyboard['y'] if keyboard else height - 35
        chrome = [i['frame']['y'] + i['frame']['height'] + 16 for i in items
                  if i.get('type') == 'Button' and i.get('AXLabel') in ('Save', 'Cancel')
                  and 0 <= i['frame']['y'] < 180]
        top = max([100] + chrome)
        if row and top <= row['frame']['y'] and row['frame']['y'] + row['frame']['height'] < bottom:
            return row
        down = row is not None and row['frame']['y'] < top
        ui.axe('drag', '--start-x', '80', '--start-y', str(bottom * (.45 if down else .85)),
               '--end-x', '80', '--end-y', str(bottom * (.85 if down else .45)), '--duration', '.4')
    raise AssertionError('Not visible: ' + identifier)


def tap(identifier):
    visible(identifier)
    ui.axe('tap', '--id', identifier)


def enter(identifier, text, secret=False):
    frame = visible(identifier)['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] / 2), '--tap-style', 'physical')
    ui.wait(lambda items: ui.keyboard_ready(items), 'Software keyboard missing: ' + identifier)
    visible(identifier)
    ui.wait_for_keyboard(identifier)
    field = ui.element(identifier)
    if field.get('AXValue'):
        def clear_button(items):
            frame = next(i['frame'] for i in items if i.get('AXUniqueId') == identifier)
            return next((i for i in items if i.get('AXLabel') == 'Clear text'
                         and frame['x'] <= i['frame']['x'] < frame['x'] + frame['width']
                         and frame['y'] <= i['frame']['y'] < frame['y'] + frame['height']), None)
        button = ui.wait(clear_button, 'Native clear button missing: ' + identifier)['frame']
        ui.axe('tap', '-x', str(button['x'] + button['width'] / 2), '-y', str(button['y'] + button['height'] / 2))
        ui.wait(lambda items: any(i.get('AXUniqueId') == identifier and not i.get('AXValue') for i in items),
                'Field did not clear: ' + identifier)
    try:
        if text:
            # Native Paste avoids AXe HID modifier-state contamination.
            # All inputs are synthetic; exact field values remain asserted.
            subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input=text, text=True, check=True)
            frame = ui.element(identifier)['frame']
            ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2),
                   '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
            pasted = ui.wait(lambda items: max((i for i in items if i.get('AXLabel') == 'Paste'),
                            key=lambda i: i['frame']['width'] * i['frame']['height'], default=None), 'Missing native Paste')['frame']
            ui.axe('tap', '-x', str(pasted['x'] + pasted['width'] / 2), '-y', str(pasted['y'] + pasted['height'] / 2))
            if any(i.get('AXLabel') == 'Allow Paste' for i in ui.state()):
                ui.axe('tap', '--label', 'Allow Paste')
    finally:
        ui.restore_software_keyboard()
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier and (bool(i.get('AXValue')) if secret else i.get('AXValue') == text) for i in items),
            'Input did not commit: ' + identifier)


def toolbar(key):
    label = catalog.text(key)
    ui.wait(lambda items: any(i.get('AXLabel') == label and i.get('type') == 'Button' for i in items), 'Missing toolbar ' + key)
    ui.axe('tap', '--label', label)


def saved_row(identifier, name):
    return ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == identifier and name in (i.get('AXLabel') or '')
                                     and not any(j.get('AXUniqueId') == 'provider-name' for j in items)), None),
                   'Save did not return the provider row: ' + name)


def row_action(identifier, key):
    frame = visible(identifier)['frame']
    y = frame['y'] + frame['height'] / 2
    ui.axe('drag', '--start-x', str(frame['x'] + frame['width'] - 15), '--start-y', str(y),
           '--end-x', str(frame['x'] + frame['width'] * .45), '--end-y', str(y), '--duration', '.5')
    toolbar(key)


def machine(identifier):
    tap('provider-machine-picker')
    tap('provider-machine:' + identifier)
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'provider-machine:' + identifier for i in items), 'Picker did not dismiss')


ui.element('provider-machine-picker')
ui.element('provider:codex')
ui.capture('providers')
machine('empty')
ui.element('providers-empty')
ui.capture('empty-machine')
tap('provider-add')
ui.element('provider-name')
tap('provider-type')
toolbar('settings.providers.custom')
enter('provider-command', '/usr/bin/example-acp')
enter('provider-name', 'Fixture provider')
toolbar('settings.remote.save')
created = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').startswith('provider:')
                                    and (i.get('AXLabel') or '').startswith('Fixture provider')
                                    and not any(j.get('AXUniqueId') == 'provider-name' for j in items)), None),
                  'Created provider row did not appear')
created_id = created['AXUniqueId']
ui.capture('provider-created')
row_action(created_id, 'settings.providers.delete')
toolbar('settings.providers.delete')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'providers-empty' for i in items)
        and not any(i.get('AXUniqueId') == created_id for i in items), 'Deleted provider remained')
ui.capture('provider-deleted')

# Switching away from custom must not leak its hidden command into a builtin save.
tap('provider-add')
tap('provider-type')
toolbar('settings.providers.custom')
enter('provider-command', '/usr/bin/discarded-command')
ui.axe('drag', '--start-x', '80', '--start-y', '200', '--end-x', '80', '--end-y', '400', '--duration', '.4')
tap('provider-type')
ui.axe('tap', '--label', 'Codex')
enter('provider-name', 'Switched builtin')
toolbar('settings.remote.save')
ui.wait(lambda items: any((i.get('AXUniqueId') or '').startswith('provider-setup:') and 'Switched builtin' in (i.get('AXLabel') or '') for i in items),
        'Builtin save retained hidden custom launch fields')

machine('studio')
tap('provider:codex')
assert ui.element('provider-prompt')['AXValue'] == 'Keep changes focused.'
enter('provider-name', 'Codex Personal')
enter('provider-description', 'Synthetic advanced settings')
enter('provider-env-key', 'FIXTURE_OPTION')
enter('provider-env-value', 'synthetic-value', secret=True)
tap('provider-env-add')
toolbar('settings.remote.save')
saved_row('provider:codex', 'Codex Personal')
tap('provider:codex')
visible('provider-description')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'provider-description' and i.get('AXValue') == 'Synthetic advanced settings' for i in items), 'Description did not persist')
tap('provider-env-mode:FIXTURE_OPTION')
toolbar('settings.providers.envRemove')
tap('provider-sign-in')
tap('provider-auth-method:fixture-sign-in')
enter('provider-auth-field:code', 'synthetic-code', secret=True)
tap('provider-auth-submit')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'provider-auth-status' and catalog.text('settings.providers.auth.authenticated') in (i.get('AXLabel') or '') for i in items), 'Sign-in did not complete')
ui.capture('provider-authenticated')
tap('provider-auth-done')
tap('provider-binary-status')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'provider-operation-status' and catalog.text('settings.providers.binary.installed') in (i.get('AXLabel') or '') for i in items), 'Runtime status did not arrive')
tap('provider-rate-limits-refresh')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'provider-operation-status' and catalog.text('settings.providers.operationComplete') in (i.get('AXLabel') or '') for i in items), 'Quota refresh did not complete')
ui.capture('provider-advanced')
toolbar('settings.remote.save')
saved_row('provider:codex', 'Codex Personal')
row_action('provider:codex', 'settings.providers.refresh')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'lody.toast' and catalog.text('settings.providers.authRequired') in (i.get('AXLabel') or '') for i in items),
        'Refresh did not expose sign-in requirement')
ui.capture('provider-auth-required')
row_action('provider:codex', 'settings.providers.refresh')
settings_states.notice(ui)
assert any(i.get('AXUniqueId') == 'provider:codex' for i in ui.state()), 'Refresh failure discarded provider'
ui.capture('provider-refresh-failed')
tap('list-notice-action')
ui.wait(lambda items: not settings_states.has_notice(items), 'Readback did not clear failure')

# A failed save keeps the draft and requires a fresh read before another attempt.
tap('provider:codex')
enter('provider-name', 'Rejected fixture')
toolbar('settings.remote.save')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'lody.toast' and catalog.text('settings.providers.writeFailed') in (i.get('AXLabel') or '') for i in items),
        'Unconfirmed save did not show result-check feedback')
assert ui.element('provider-name')['AXValue'] == 'Rejected fixture'
ui.capture('provider-write-failed')
toolbar('common.cancel')
saved_row('provider:codex', 'Codex Personal')

tap('provider-setup:setup')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'provider-setup:setup' and catalog.text('settings.providers.setup.queued') in (i.get('AXLabel') or '') for i in items),
        'Setup retry did not reach queued state')
row_action('provider-setup:setup', 'settings.providers.delete')
toolbar('settings.providers.delete')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'provider-setup:setup' for i in items), 'Setup deletion did not reach list')
ui.capture('setup-deleted')
machine('team')
ui.element('provider:team-codex')
assert not any(i.get('AXUniqueId') == 'provider-add' for i in ui.state())
tap('provider:team-codex')
ui.element('provider-name')
ui.element('provider-prompt')
assert not any(i.get('AXLabel') == catalog.text('settings.remote.save') and i.get('type') == 'Button' for i in ui.state()), 'Read-only provider offered Save'
visible('provider-env-key')
ui.capture('readonly-provider')
print('PASS: machine picker, creation, custom switch, edit/delete, refresh/auth/failure, failed save, setup retry/delete and read-only editor')
