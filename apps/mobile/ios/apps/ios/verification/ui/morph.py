"""System sheet zoom: reversible dismissal and first-message composer handoff.

Review run.mp4: the source button expands into the sheet and cancellation returns
to it. Sending must remain continuous when navigation removes the source button.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
folder = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()) / 'tmp'
started = time.monotonic()
events = []

def mark(action):
    events.append({'action': action, 'secondsFromFirstAction': time.monotonic() - started})

close = catalog.text('accessibility.closeSheet', title=catalog.text('create.title'))
source = max(
    (i for i in ui.state() if i.get('type') == 'Button' and i.get('frame')),
    key=lambda i: i['frame']['y'],
)['frame']
source_x = source['x'] + source['width'] / 2
source_y = source['y'] + source['height'] / 2

def open_sheet():
    buttons = [i for i in ui.state() if i.get('type') == 'Button' and i.get('frame')]
    frame = max(buttons, key=lambda i: i['frame']['y'])['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '1')
    ui.element('create-session-input')

# Keep the dismissal and repeated taps in one HID session. Reading accessibility
# between them would wait out the transition and hide the reopening race.
for attempt in range(3):
    open_sheet()
    draft = 'dismissed draft'
    if attempt == 1:
        ui.axe('tap', '--id', 'create-session-input', '--post-delay', '.4')
        ui.type_into('create-session-input', draft)
        draft = ui.element('create-session-input')['AXValue']
    header = next(i['frame'] for i in ui.state() if i.get('AXLabel') == close)
    steps = ['tap -x %s -y %s --tap-style physical' % (
        header['x'] + header['width'] / 2, header['y'] + header['height'] / 2)]
    for _ in range(4):
        steps += ['sleep .2', f'tap -x {source_x} -y {source_y} --tap-style physical']
    mark(f'rapid-reopen-{attempt}')
    ui.axe('batch', *[arg for step in steps for arg in ('--step', step)])
    ui.element('create-session-input')
    if attempt == 1:
        ui.wait(lambda items: any(i.get('AXUniqueId') == 'create-session-input'
                and draft not in (i.get('AXValue') or '') for i in items),
                'Rapid reopening retained the dismissed sheet and its draft')
    ui.capture(f'rapid-reopened-{attempt}')
    assert json.loads(ui.element('ui-navigation-state')['AXValue']) == [
        'index', 'presented/[presentationId]'], 'Rapid taps stacked creation sheets'
    ui.axe('tap', '--label', close, '--post-delay', '1')
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'create-session-input' for i in items),
            'Rapidly reopened sheet did not close')
    assert json.loads(ui.element('ui-navigation-state')['AXValue']) == ['index'], (
        'Rapid reopening left a stale Router presentation')

for action in ('close', 'backdrop', 'swipe', 'send'):
    mark(action + '-open')
    open_sheet()
    ui.capture(action + '-open')
    if action == 'close':
        header = next(i['frame'] for i in ui.state() if i.get('AXLabel') == close)
        x, y = header['x'] + header['width'] / 2, header['y'] + header['height'] / 2
        ui.axe('swipe', '--start-x', str(x), '--start-y', str(y),
               '--end-x', str(x), '--end-y', str(y + 45), '--duration', '1', '--post-delay', '1')
        ui.element('create-session-input')
        ui.capture('cancelled-drag')
        mark('close-dismiss')
        ui.axe('tap', '--label', close, '--post-delay', '1')
    elif action == 'swipe':
        header = next(i['frame'] for i in ui.state() if i.get('AXLabel') == close)
        x, y = header['x'] + header['width'] / 2, header['y'] + header['height'] / 2
        mark('swipe-dismiss')
        ui.axe('swipe', '--start-x', str(x), '--start-y', str(y),
               '--end-x', str(x), '--end-y', str(y + 450), '--duration', '.5', '--post-delay', '1')
    elif action == 'backdrop':
        mark('backdrop-dismiss')
        ui.axe('tap', '-x', '30', '-y', '180', '--tap-style', 'physical', '--post-delay', '1')
    else:
        (folder / 'lody-production-composer-relay.json').unlink(missing_ok=True)
        frame = ui.element('create-type')['frame']
        ui.axe('tap', '-x', str(frame['x'] + frame['width'] * .75), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '1')
        ui.axe('tap', '--id', 'create-session-input')
        ui.type_into('create-session-input', 'System zoom handoff')
        ui.capture('send-draft')
        draft = ui.element('create-session-input')['AXValue']
        mark('send-dismiss')
        ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
        ui.element('session-input')
        ui.wait(lambda items: any(i.get('AXLabel') == draft and (i.get('AXUniqueId') or '').endswith(':user') for i in items), 'Sent draft did not reach the conversation')
        relay = json.loads((folder / 'lody-production-composer-relay.json').read_text())
        assert relay['sameComposer'] and relay['inputBefore'] == relay['inputAfter'], 'Zoom interrupted the composer handoff'
        assert relay['inputBefore']['focused'], 'Zoom lost keyboard focus'
        source_frame, adopted = relay['source'], relay['adopted']
        assert abs(source_frame[0] - adopted[0]) < 1.5 and abs(source_frame[2] - adopted[2]) < 1.5, 'Zoom changed composer width or alignment'
        assert abs(source_frame[1] + source_frame[3] - adopted[1] - adopted[3]) < 1.5, 'Zoom moved the keyboard edge'
        # Match send-handoff: Chat adds its fullscreen grabber above the form's
        # input while keeping the input and keyboard edge aligned.
        grabber = ui.element('session-grabber')['frame']
        assert abs(adopted[3] - source_frame[3] - grabber['height']) < 1.5, 'Unexpected composer growth during zoom handoff'
        shutil.copy2(folder / 'lody-production-composer-relay.json', ui.output)
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'create-session-input' for i in items), action + ' left the sheet visible')
    ui.capture(action + '-closed')
    if action != 'send':
        ui.element('ui-design')
        probe = ui.element('ui-navigation-state')
        assert json.loads(probe['AXValue']) == ['index'], 'Dismissal left a stale Router presentation'
    mark(action + '-settled')
(ui.output / 'transition-events.json').write_text(json.dumps(events, indent=2))
print('PASS: three rapid close/reopen rounds, including a focused draft, preserve one creation sheet; close, cancelled drag, backdrop, completed swipe and send preserve sheet lifecycle and composer handoff. VISUAL REVIEW REQUIRED: system button-to-sheet zoom and source-less send dismissal.')
