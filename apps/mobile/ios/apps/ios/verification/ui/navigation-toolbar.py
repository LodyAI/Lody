"""Record native Search fading across pushes, cancelled pops and returns.

Visual gate: compare run.mp4 with Settings. Search must blur/fade, not disappear
abruptly; its retiring glass must not reappear or remain after the transition.
The accessibility assertions below only establish settled ownership/usability.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

import catalog
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
existing = set((container / 'tmp').glob('lody-scroll-*.json'))
search_label = catalog.text('search.field.placeholder')


def home():
    ui.element('ui-design')
    ui.wait(lambda items: any(i.get('AXValue') == search_label for i in items),
            'Home search did not return')


def session():
    ui.element('session-input')
    ui.wait(lambda items: not any(i.get('AXValue') == search_label for i in items),
            'Home search leaked over the session')


events = []
started = time.monotonic()


def action(name, *arguments):
    events.append({'action': name, 'secondsFromFirstAction': time.monotonic() - started})
    ui.axe(*arguments)


home()
ui.capture('home')
for index in range(2):
    action(f'push-{index}', 'tap', '--id', 'ui-design', '--post-delay', '.8')
    session()
    ui.capture(f'pushed-{index}')
    action(f'cancel-pop-{index}', 'swipe', '--start-x', '1', '--start-y', '650',
           '--end-x', '65', '--end-y', '650', '--duration', '1', '--post-delay', '.8')
    session()
    ui.capture(f'cancelled-{index}')
    action(f'complete-pop-{index}', 'drag', '--start-x', '1', '--start-y', '650',
           '--end-x', '350', '--end-y', '650', '--duration', '.5', '--post-delay', '.8')
    home()
    ui.capture(f'returned-{index}')

# Capture from the first display callback, including the opening push. Waiting
# for a settled text element alone would miss the reported empty-screen flash.
traces = sorted(set((container / 'tmp').glob('lody-scroll-*.json')) - existing)
assert len(traces) == 2, f'Expected two independent session openings, got {len(traces)}'
for index, path in enumerate(traces):
    shutil.copy2(path, ui.output / f'opening-{index}.json')
    samples = json.loads(path.read_text())['samples']
    assert samples and samples[0]['count'] > 0, 'First session frame has no cached history'
    assert all(not sample['loadingVisible'] for sample in samples), 'Cached session flashed its loading screen'
    assert samples[0]['rows'], 'First session frame has no visible message cells'

# Restored controls must remain usable after repeated transition cancellation.
action('activate-search', 'tap', '--value', search_label, '--post-delay', '.5')
ui.axe('type', 'Search')
if catalog.LANGUAGE != 'en':
    ui.axe('key', '40')
ui.element('ui-search')
ui.capture('search-active')
labels = {catalog.system('cancel').lower(), catalog.system('close').lower()}
button = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button'
                 and (i.get('AXLabel') or '').lower() in labels), None),
                 'Missing search dismiss button')
ui.axe('tap', '--label', button['AXLabel'], '--post-delay', '.5')
home()
ui.capture('search-cancelled')
(ui.output / 'transition-events.json').write_text(json.dumps(events, indent=2))
print('PASS: repeated Home pushes, cancelled edge pops and completed returns preserve settled toolbar ownership and usable search. VISUAL REVIEW REQUIRED: continuous native Search fade, no abrupt removal, late reappearance or post-transition residue.')
