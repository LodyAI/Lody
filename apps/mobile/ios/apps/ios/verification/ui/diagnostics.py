"""Production diagnostic UI and native rolling files, with isolated offline events."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

import catalog
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])


def label(value):
    return ui.wait(lambda items: next((item for item in items if item.get('AXLabel') == value), None), f'Missing {value}')


def tap_label(value):
    node = label(value)
    frame = node['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2))


def count(value):
    ui.wait(lambda items: any(item.get('AXUniqueId') == 'diagnostics-count' and item.get('AXLabel') == catalog.plural('diagnostics.events', value) for item in items), f'Expected {value} diagnostic events')


def show_feedback(key):
    for _ in range(4):
        frame = label(catalog.text(key))['frame']
        if frame['y'] + frame['height'] <= 841:
            return
        ui.axe('swipe', '--start-x', '210', '--start-y', '760', '--end-x', '210', '--end-y', '560', '--duration', '.3')
    raise AssertionError(f'Feedback is outside the viewport: {key}')


def choose(key, expected):
    ui.axe('tap', '--id', 'diagnostics-range')
    tap_label(catalog.text(key))
    count(expected)


count(3)
ui.capture('diagnostics-hour')
choose('diagnostics.range.quarterHour', 2)
ui.capture('diagnostics-quarter-hour')
choose('diagnostics.range.day', 4)
choose('diagnostics.range.week', 5)
ui.capture('diagnostics-week')

# The first export rejects at the service boundary; the second uses real native sharing.
ui.axe('tap', '--id', 'diagnostics-export')
label(catalog.text('diagnostics.exportFailed'))
count(5)
ui.capture('diagnostics-export-failed')
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
previous_exports = set((container / 'tmp/LodyDiagnostics').glob('*/diagnostics.txt'))
ui.axe('tap', '--id', 'diagnostics-export')
ui.element('ActivityListView')
ui.capture('diagnostics-system-share')
exports = list(set((container / 'tmp/LodyDiagnostics').glob('*/diagnostics.txt')) - previous_exports)
assert len(exports) == 1, exports
export_file = ui.output / 'diagnostics.txt'
shutil.copy2(exports[0], export_file)
text = export_file.read_text()
records = [json.loads(line) for line in text.splitlines() if line.startswith('{')]
assert len(records) == 5
assert {record['process'] for record in records} == {'app', 'notificationService'}
assert [record['at'] for record in records] == sorted(record['at'] for record in records)
assert 'Lody diagnostics' in text and 'OS:' in text
frame = ui.element('ActivityListView')['frame']
ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] - 24))
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'ActivityListView' for item in items), 'Share sheet did not dismiss')
assert not exports[0].exists(), 'Dismissal left an exported temporary file'

ui.axe('tap', '--id', 'diagnostics-read-failure')
label(catalog.text('diagnostics.readFailed'))
ui.element('diagnostics-retry')
ui.capture('diagnostics-read-failed')
ui.axe('tap', '--id', 'diagnostics-read-failure')
count(5)

def show_clear():
    for _ in range(5):
        node = next((item for item in ui.state() if item.get('AXUniqueId') == 'diagnostics-clear' and item['frame']['y'] < 800), None)
        if node:
            ui.axe('tap', '--id', 'diagnostics-clear')
            label(catalog.text('diagnostics.confirmTitle'))
            return
        ui.axe('swipe', '--start-x', '210', '--start-y', '760', '--end-x', '210', '--end-y', '330', '--duration', '.4')
    raise AssertionError('Clear diagnostics row never became visible')


show_clear()
ui.capture('diagnostics-clear-confirmation')
tap_label(catalog.text('common.cancel'))
ui.axe('swipe', '--start-x', '210', '--start-y', '340', '--end-x', '210', '--end-y', '780', '--duration', '.4')
count(5)
ui.axe('tap', '--id', 'diagnostics-clear-failure')
show_clear()
tap_label(catalog.text('diagnostics.confirm'))
show_feedback('diagnostics.clearFailed')
ui.capture('diagnostics-clear-failed')
ui.axe('tap', '--id', 'diagnostics-clear-failure')
show_clear()
tap_label(catalog.text('diagnostics.confirm'))
show_feedback('diagnostics.cleared')
ui.capture('diagnostics-cleared')
ui.axe('swipe', '--start-x', '210', '--start-y', '340', '--end-x', '210', '--end-y', '780', '--duration', '.4')
count(0)
ui.capture('diagnostics-empty')

# Enter through the actual signed-out Settings page and capture the production layout.
ui.open_case('diagnostics-settings-preview')
for _ in range(5):
    node = next((item for item in ui.state() if item.get('AXUniqueId') == 'diagnostics' and 100 < item['frame']['y'] < 800), None)
    if node:
        ui.axe('tap', '--id', 'diagnostics')
        break
    ui.axe('swipe', '--start-x', '210', '--start-y', '760', '--end-x', '210', '--end-y', '330', '--duration', '.4')
else:
    raise AssertionError('Signed-out Settings does not expose Diagnostics')
ui.element('diagnostics-export')
ui.capture('diagnostics-production')
show_feedback('diagnostics.retention')
ui.capture('diagnostics-retention')
print('PASS: four time ranges, actual merged export, share dismissal cleanup, export/read/clear failure recovery, clear cancellation and empty state')
