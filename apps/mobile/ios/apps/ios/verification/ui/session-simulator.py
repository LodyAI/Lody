"""Native session simulator navigation borrows and returns one chat-owned decoder."""
import json
import re
import subprocess
import sys
from pathlib import Path
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
container = Path(subprocess.check_output(
    ['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
traces = container / 'tmp'


def stream():
    def decoded(items):
        for item in items:
            if item.get('AXUniqueId') != 'simulator-stream':
                continue
            match = re.fullmatch(r'stream:([^,]+),connections:(\d+),active:(\d+),frame:(\d+)',
                                 item.get('AXValue') or '')
            if match and int(match[4]) > 0:
                return match
        return None
    match = ui.wait(decoded, 'No decoded native simulator frame')
    assert (match[2], match[3]) == ('1', '1'), match[0]
    return match[1]


ui.element('session-preview-probe')
ui.axe('tap', '--label', catalog.text('common.more'), '--post-delay', '.5')
item = ui.wait(lambda items: next((i for i in items
    if (i.get('AXLabel') or '').startswith(catalog.text('simulator.menu'))), None), 'No simulator action')
f = item['frame']
ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.5')
identity = stream()
ui.capture('fullscreen')
for index in range(2):
    before = set(traces.glob('lody-simulator-motion-land-*.json'))
    ui.axe('tap', '--id', 'BackButton', '--post-delay', '.8')
    ui.element('simulator-preview-expand')
    assert stream() == identity, 'Returning recreated the decoder'
    landed = ui.wait(lambda _: set(traces.glob('lody-simulator-motion-land-*.json')) - before or None,
                     'Missing native zoom landing')
    motion = json.loads(next(iter(landed)).read_text())
    assert motion['zoomed'] and motion['standIn'] and not motion['hiddenWhileLanding'], motion
    (ui.output / f'landing-{index}.json').write_text(json.dumps(motion))
    ui.capture(f'floating-{index}')
    if index == 0:
        ui.axe('tap', '--id', 'simulator-preview-expand', '--post-delay', '.7')
        assert stream() == identity, 'Expanding recreated the decoder'
ui.axe('tap', '--id', 'simulator-preview-close', '--post-delay', '.5')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'simulator-preview-expand' for i in items), 'Close kept the PiP visible')
ui.element('session-input')
ui.capture('closed')
print('PASS: native full-screen and PiP reuse one decoder, both returns zoom into a visible stand-in, and Close hides the preview.')
