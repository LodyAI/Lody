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
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier and (bool(i.get('AXValue')) if secret else (i.get('AXValue') or '') == text) for i in items),
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



case = sys.argv[3]
if case != 'agents-auth-methods':
    ui.element('provider-machine-picker')


def value(identifier, expected):
    visible(identifier)
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier and (i.get('AXValue') or '') == expected for i in items),
            'Saved field differs: ' + identifier)


def extension(path, selected):
    identifier = 'provider-extension:/fixture/extensions/' + path
    row = visible(identifier)
    assert ('✓' in (row.get('AXLabel') or '')) == selected, 'Incorrect persisted Pi selection: ' + path
    return identifier


if case == 'agents-presets':
    tap('provider:preset-agent')
    tap('provider-credential-mode')
    ui.axe('tap', '--label', 'Custom endpoint')
    enter('provider-endpoint', 'https://custom.fixture.invalid/v2')
    enter('provider-credential', 'fixture-synthetic-key', secret=True)
    visible('provider-env-mode:KEEP_ME')
    assert not any(i.get('AXUniqueId') == 'provider-env-mode:FIXTURE_API_KEY' for i in ui.state()), 'Preset secret exposed as a generic env editor'
    ui.capture('preset-draft')
    toolbar('settings.remote.save')
    saved_row('provider:preset-agent', 'Fixture gateway')
    tap('provider:preset-agent')
    value('provider-endpoint', 'https://custom.fixture.invalid/v2')
    value('provider-credential', '')
    ui.capture('preset-reopened')
    # A name-only edit must omit preset fields and credentials, preserving the custom endpoint.
    enter('provider-name', 'Fixture gateway renamed')
    toolbar('settings.remote.save')
    saved_row('provider:preset-agent', 'Fixture gateway renamed')
    tap('provider:preset-agent')
    value('provider-endpoint', 'https://custom.fixture.invalid/v2')
    value('provider-credential', '')
    ui.capture('preset-preserved')
    print('PASS: preset mode, custom endpoint, write-only credential, protected env and unrelated-edit preservation')
elif case == 'agents-pi':
    tap('provider:pi-agent')
    value('provider-runtime-path', '/fixture/bin/pi')
    tap('provider-pi-extension-scan')
    extension('retained', True)
    tap(extension('example', False))
    extension('example', True)
    ui.capture('pi-selection')
    toolbar('settings.remote.save')
    saved_row('provider:pi-agent', 'Fixture Pi')
    tap('provider:pi-agent')
    value('provider-runtime-path', '/fixture/bin/pi')
    tap('provider-pi-extension-scan')
    extension('retained', True)
    tap(extension('example', True))
    extension('example', False)
    enter('provider-runtime-path', '')
    toolbar('settings.remote.save')
    saved_row('provider:pi-agent', 'Fixture Pi')
    tap('provider:pi-agent')
    value('provider-runtime-path', '')
    tap('provider-pi-extension-scan')
    extension('retained', True)
    extension('example', False)
    ui.capture('pi-removal-preserved')
    print('PASS: Pi scan, persisted selection/deselection, runtime-path removal and untouched-extension preservation')
elif case == 'agents-auth-methods':
    tap('provider-auth-start')
    tap('provider-auth-method:browser')
    tap('provider-auth-method:organization')
    row = ui.element('provider-auth-open')
    assert row.get('enabled') is False, 'Authorization URL must remain disabled before consent receipt'
    ui.capture('auth-awaiting-consent')
    tap('provider-auth-consent')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'provider-auth-open' and i.get('enabled') is True for i in items),
            'Authorization URL did not enable after accepted consent')
    # Never open an external URL: the synthetic machine checks the receipt order.
    enter('provider-auth-field:code', 'fixture-final-code', secret=True)
    tap('provider-auth-submit')
    ui.element('provider-auth-done')
    ui.capture('auth-methods-completed')
    print('PASS: method selection starts a fresh flow without interaction, submits within an interaction, and gates browser opening on consent receipt')
else:
    raise AssertionError('Unknown advanced provider case: ' + case)
