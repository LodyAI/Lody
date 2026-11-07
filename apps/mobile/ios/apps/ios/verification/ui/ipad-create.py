"""Create two native sessions across iPad orientations without losing the composer."""
import json
from pathlib import Path
import subprocess
import sys
from driver import UI
import catalog
import pad
import rotation

ui = UI(*sys.argv[1:])
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid,
                                        'ai.lody.mobile', 'data'], text=True).strip())
report = container / 'tmp/lody-production-composer-relay.json'
for orientation in ['landscape', 'portrait']:
    if ui.visible_keyboard(ui.state()):
        ui.axe('tap', '--label', 'Hide keyboard', '--post-delay', '.5')
    rotation.rotate(ui, orientation)
    pad.show_list(ui)
    ui.axe('tap', '--label', catalog.text('tabs.newSession'), '--post-delay', '.6')
    ui.element('create-session-input')
    ui.axe('tap', '--id', 'create-session-input', '--post-delay', '.5')
    ui.type_into('create-session-input', f'Create {orientation} session')
    draft = ui.element('create-session-input')['AXValue']
    ui.capture(orientation + '-draft')
    field = ui.element('create-session-input')['frame']
    send = min((item['frame'] for item in ui.state()
                if item.get('AXUniqueId') == 'session-send'
                and field['x'] <= item['frame']['x'] < field['x'] + field['width']),
               key=lambda frame: abs(frame['y'] - field['y'] - field['height']))
    report.unlink(missing_ok=True)
    ui.axe('tap', '-x', str(send['x'] + send['width'] / 2),
           '-y', str(send['y'] + send['height'] / 2), '--post-delay', '.5')
    ui.wait(lambda items: any(item.get('AXLabel') == draft
                             and (item.get('AXUniqueId') or '').endswith(':user') for item in items),
            'Created session did not display its draft')
    ui.wait(lambda items: not any(item.get('AXUniqueId') == 'create-session-input' for item in items),
            'Creation sheet did not release its composer')
    ui.element('session-input')
    relay = json.loads(report.read_text())
    assert relay['sameComposer'] and relay['destinationContentRestored'], relay
    assert relay['inputBefore']['focused'] and relay['inputAfter']['focused'], relay
    (ui.output / (orientation + '-relay.json')).write_text(json.dumps(relay))
    ui.capture(orientation + '-sent')
pad.show_list(ui)
sessions = {item['AXUniqueId'] for item in ui.state()
            if (item.get('AXUniqueId') or '').startswith('ui-new-')}
assert len(sessions) == 2, f'Creation reused a session identity: {sessions}'
ui.capture('two-created-sessions')
print('PASS: landscape and portrait creation dismiss, retain the same focused composer, and display the original first message.')
