"""The overflow menu opens a picked device; one live decoder survives full-screen/back,
dragging and typing; close hides it, choosing another device replaces it, stop ends it."""
import re
import sys
import json
import shutil
import time
import subprocess
from pathlib import Path
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
container = Path(subprocess.check_output(
    ['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
traces = container / 'tmp'
entrances = 0


def rendered_device(name):
    # UIKit renders interactive zoom through a transition container; the
    # renderer's own layer/AX frame stays unchanged. Measure actual pixels.
    width = 402
    pixels = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(ui.output / f'{name}.png'),
        '-vf', f'scale={width}:-1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], timeout=20)
    points = [i // 3 for i in range(0, len(pixels), 3)
              if pixels[i + 2] > pixels[i] + 65 and pixels[i + 2] > pixels[i + 1] + 65
              and abs(pixels[i] - pixels[i + 1]) < 35]
    assert points, f'{name}: no decoded device frame was visible'
    xs = [point % width for point in points]
    ys = [point // width for point in points]
    return {'width': max(xs) - min(xs), 'top': min(ys), 'height': max(ys) - min(ys)}


def stream():
    item = ui.element('simulator-stream')
    value = item.get('AXValue') or ''
    match = re.fullmatch(r'stream:([^,]+),connections:(\d+),active:(\d+),frame:(\d+)', value)
    assert match, f'Fixture has not decoded a frame: {value}'
    assert int(match[3]) == 1, f'A previous stream is still running: {value}'
    return match[1], int(match[2]), int(match[4])


def motions(kind):
    return set(traces.glob(f'lody-simulator-motion-{kind}-*.json'))


def motion(kind, before):
    paths = ui.wait(lambda _: motions(kind) - before or None, f'No {kind} motion was recorded')
    assert len(paths) == 1, f'Expected one {kind} motion: {paths}'
    path = paths.pop()
    shutil.copy2(path, ui.output / f'{kind}-{len(list(ui.output.glob(f"{kind}-*.json"))) + 1}.json')
    return json.loads(path.read_text())


def back():
    global entrances
    before = motions('land')
    ui.axe('tap', '--id', 'BackButton', '--post-delay', '.8')
    ui.element('simulator-preview-expand')
    landing = motion('land', before)
    assert landing['zoomed'], 'The pop did not zoom into the PiP'
    assert landing['standIn'] and not landing['hiddenWhileLanding'], f'The PiP was empty while the zoom landed: {landing}'
    entrances += 1


def open_simulator(name='iPhone Simulator'):
    ui.axe('tap', '--label', catalog.text('common.more'), '--post-delay', '.6')
    title = catalog.text('simulator.menu')
    entry = ui.wait(
        lambda items: next((i for i in items if (i.get('AXLabel') or '').startswith(title)), None),
        'The overflow menu has no simulator entry')['frame']
    ui.axe('tap', '-x', str(entry['x'] + entry['width'] / 2), '-y', str(entry['y'] + entry['height'] / 2), '--post-delay', '.8')
    chooser = catalog.text('simulator.section.booted')

    def opened(items):
        if any(i.get('AXUniqueId') == 'simulator-stream' for i in items):
            return 'stream'
        return 'chooser' if any(i.get('AXLabel') == chooser for i in items) else None

    if ui.wait(opened, 'Neither a running preview nor the device chooser opened') == 'chooser':
        ui.axe('tap', '--label', name, '--post-delay', '1')


def screen_menu(action):
    ui.axe('tap', '--label', catalog.text('common.more'), '--post-delay', '.6')
    ui.axe('tap', '--label', action, '--post-delay', '.8')


def chip_label(target):
    return catalog.text('simulator.chip.open', target=target)


def tap_chip(name, taps=1):
    chip = ui.element('session-preview')['frame']
    point = ('-x', str(chip['x'] + chip['width'] / 2), '-y', str(chip['y'] + chip['height'] / 2))
    started = time.monotonic()
    steps = []
    for _ in range(taps):
        steps += ['--step', 'tap ' + ' '.join(point) + ' --tap-style physical']
    ui.axe('batch', *steps)
    # The fixture delays the first resume by 8 s; every tap must land before the first push.
    elapsed = time.monotonic() - started
    assert elapsed < 7.5, f'Repeated taps took {elapsed:.1f}s, too slow to race the resume'
    time.sleep(.8)
    chooser = catalog.text('simulator.section.booted')

    def opened(items):
        if any(i.get('AXUniqueId') == 'simulator-stream' for i in items):
            return 'stream'
        return 'chooser' if any(i.get('AXLabel') == chooser for i in items) else None

    if ui.wait(opened, 'The simulator chip opened nothing') == 'chooser':
        ui.axe('tap', '--label', name, '--post-delay', '1')


assert ui.element('session-preview')['AXLabel'] == chip_label(catalog.text('simulator.menu')), 'The agent hint did not show the chip'
tap_chip('Second Simulator', taps=3)
assert ui.element('simulator-stream')['AXLabel'] == 'Second Simulator', 'The chip did not resume the agent-started preview'
first = stream()
assert first[1] == 1
ui.capture('fullscreen')
before_swipes = motions('land')
display = ui.element('simulator-stream')['frame']
left = display['x'] + display['width'] * .2
right = display['x'] + display['width'] * .8
center_y = display['y'] + display['height'] * .5
center_x = display['x'] + display['width'] * .5
for name, start_x, start_y, end_x, end_y in (
    ('left', right, center_y, left, center_y),
    ('right', left, center_y, right, center_y),
    ('down', center_x, display['y'] + display['height'] * .3,
     center_x, display['y'] + display['height'] * .8),
):
    ui.axe('swipe', '--start-x', str(start_x), '--start-y', str(start_y),
           '--end-x', str(end_x), '--end-y', str(end_y), '--duration', '.5', '--post-delay', '.8')
    assert ui.element('simulator-stream')['frame']['width'] > 200, f'A {name} swipe inside the device dismissed Preview'
    assert stream()[0] == first[0], f'A {name} swipe replaced the decoder'
    assert motions('land') == before_swipes, f'A {name} swipe started a navigation return'
    ui.capture(f'device-swipe-{name}')
# First-open dismissal must already be interactive.
before_swipes = motions('land')
command = ['axe', 'swipe', '--start-x', '15', '--start-y', '300',
           '--end-x', '15', '--end-y', '360', '--duration', '6',
           '--delta', '1', '--udid', ui.udid]
gesture = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    time.sleep(2)
    ui.screenshot('return-progress-early')
    time.sleep(2)
    ui.screenshot('return-progress-late')
    assert motions('land') == before_swipes, 'The controller finished dismissing while the finger was still held'
finally:
    stdout, _ = gesture.communicate(timeout=15)
    assert gesture.returncode == 0, stdout
time.sleep(.8)


early = rendered_device('return-progress-early')
late = rendered_device('return-progress-late')
assert early['width'] - late['width'] >= 3 and late['top'] - early['top'] >= 8, (early, late)
assert ui.element('simulator-stream')['frame']['width'] > 200, 'A cancelled return left the renderer in the floating host'
assert stream()[0] == first[0], 'A cancelled return replaced the decoder'
ui.capture('cancelled-return')
restored = rendered_device('cancelled-return')
baseline = rendered_device('fullscreen')
assert all(abs(restored[key] - baseline[key]) <= 1 for key in baseline), (baseline, restored)
back()
ui.axe('tap', '--id', 'simulator-preview-expand', '--post-delay', '1')
assert stream()[0] == first[0], 'Expanding the PiP replaced the decoder'
# A longer edge swipe commits; its intermediate frames must also track touch.
before_commit = motions('land')
gesture = subprocess.Popen([
    'axe', 'swipe', '--start-x', '1', '--start-y', '450',
    '--end-x', '280', '--end-y', '450', '--duration', '6',
    '--delta', '2', '--udid', ui.udid,
], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    time.sleep(2)
    ui.screenshot('commit-progress-early')
    time.sleep(2)
    ui.screenshot('commit-progress-late')
    assert motions('land') == before_commit, 'Edge swipe dismissed before release'
finally:
    stdout, _ = gesture.communicate(timeout=15)
    assert gesture.returncode == 0, stdout
commit_early = rendered_device('commit-progress-early')
commit_late = rendered_device('commit-progress-late')
assert commit_early['height'] - commit_late['height'] >= 20, (commit_early, commit_late)
(ui.output / 'gesture-progress.json').write_text(json.dumps({
    'cancel': [early, late], 'commit': [commit_early, commit_late],
    'baseline': baseline, 'restored': restored,
}, indent=2))
ui.element('simulator-preview-expand')
landing = motion('land', before_commit)
assert landing['zoomed'] and landing['standIn'] and not landing['hiddenWhileLanding'], landing
entrances += 1
returned = stream()
assert returned[0] == first[0] and returned[1] == 1 and returned[2] > first[2], (first, returned)
for action in ('expand', 'close'):
    button = ui.element(f'simulator-preview-{action}')
    assert button['AXLabel'] == catalog.text(f'native.simulator.{action}'), button
ui.capture('floating')
settled_motions = set(traces.glob('lody-simulator-motion-*.json'))

before = ui.element('simulator-preview-expand')['frame']
image = ui.element('simulator-stream')['frame']
ui.axe('drag', '--start-x', str(image['x'] + image['width'] / 2),
       '--start-y', str(image['y'] + image['height'] / 2), '--end-x', '65',
       '--end-y', str(image['y'] + image['height'] / 2 + 90), '--duration', '.8', '--steps', '60', '--post-delay', '.5')
after = ui.element('simulator-preview-expand')['frame']
assert after['x'] < before['x'] - 50, (before, after)
ui.capture('dragged')

ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'draft')
close = ui.element('simulator-preview-close')['frame']
expand = ui.element('simulator-preview-expand')['frame']
image = ui.element('simulator-stream')['frame']
input_frame = ui.element('session-input')['frame']
assert image['y'] + image['height'] < input_frame['y'], (image, input_frame)
assert close['width'] >= 44 and close['height'] >= 44, close
assert expand['width'] >= 44 and expand['height'] >= 44, expand
assert expand['x'] + expand['width'] <= close['x'], (expand, close)
ui.capture('keyboard')
assert set(traces.glob('lody-simulator-motion-*.json')) == settled_motions, 'Dragging or typing replayed a motion'

ui.axe('tap', '--id', 'simulator-preview-expand', '--post-delay', '1')
expanded = stream()
assert expanded[0] == first[0] and expanded[1] == 1 and expanded[2] > returned[2], (returned, expanded)
ui.capture('expanded-again')
back()
assert (ui.element('session-input').get('AXValue') or '').casefold() == 'draft', 'Expanding lost the composer draft'
before_hide = motions('hide')
ui.axe('tap', '--id', 'simulator-preview-close', '--post-delay', '.6')
hidden = motion('hide', before_hide)
samples = hidden['samples']
assert not hidden['visible'], hidden
shadow_gone = next(i for i, s in enumerate(samples) if s['chrome'] < .05)
shrunk = next(i for i, s in enumerate(samples) if s['scale'] < .8)
assert shadow_gone <= shrunk, 'The shadow and controls must leave before the device travels'
assert min(s['scale'] for s in samples) < .45 and min(s['alpha'] for s in samples) < .2, samples[-3:]
assert not any(i.get('AXUniqueId') in ('simulator-preview-expand', 'simulator-stream') for i in ui.state()), 'Close left the stream visible'
ui.capture('closed')

open_simulator()
reopened = stream()
assert reopened[0] != first[0] and reopened[1] == 1, (first, reopened)
back()
ui.capture('reopened')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.8')
ui.open_case('simulator-preview')
ui.element('session-input')
open_simulator()
new_chat = stream()
assert new_chat[0] != reopened[0] and new_chat[1] == 1, (reopened, new_chat)
back()
ui.capture('new-chat')


other_name = 'Second Simulator' if ui.element('simulator-stream')['AXLabel'] == 'iPhone Simulator' else 'iPhone Simulator'
open_simulator()
screen_menu(catalog.text('simulator.chooseAnother'))
ui.axe('tap', '--label', other_name, '--post-delay', '1')
second = stream()
assert second[0] != new_chat[0] and second[1] == 1, (new_chat, second)
assert ui.element('simulator-stream')['AXLabel'] == other_name
ui.wait(lambda items: any(i.get('AXLabel') == other_name and i.get('AXUniqueId') != 'simulator-stream' for i in items),
        'The full-screen title kept the previous device')
ui.capture('changed-device')
screen_menu(catalog.text('simulator.stop'))
ui.wait(lambda items: not any(i.get('AXUniqueId') in ('simulator-preview-expand', 'simulator-stream') for i in items), 'Stopping left the stream visible')
ui.capture('stopped')
assert ui.element('session-preview')['AXLabel'] == chip_label(catalog.text('simulator.menu')), 'Stopping removed the agent hint'
tap_chip('iPhone Simulator')
assert ui.element('simulator-stream')['AXLabel'] == 'iPhone Simulator', 'A stopped preview must offer the chooser'
stream()
back()
assert ui.element('session-preview')['AXLabel'] == chip_label('iPhone Simulator'), 'The chip does not name the running device'
ui.capture('chip-running')
print(f'PASS: shared stream {first[0]} kept one connection and decoded frames across navigation; close created a fresh stream {reopened[0]}')
print(f'PASS: {entrances} returns zoomed the full-screen device into the PiP; hide travelled to the chip')

print('PASS: held dismissal follows touch, short drag cancels, edge drag commits into the same PiP')
