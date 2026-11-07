"""Capture the production new-session sheet and its pickers for pixel parity review."""
import subprocess
import sys
from driver import UI
import catalog

udid = sys.argv[1]
ui = UI(udid, sys.argv[2])


def tap_id(value):
    ui.element(value)
    ui.axe('tap', '--id', value, '--post-delay', '1')


def back():
    # AX includes Debug's Back behind the sheet; use the foreground stack's button.
    item = ui.wait(lambda items: max((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') in ['Back', catalog.text('create.title')]), key=lambda i: i['frame']['y'], default=None), 'Back button missing')
    f = item['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '1')
    ui.element('create-session-input')


def label(value):
    ui.wait(lambda items: any(value == (i.get('AXLabel') or '') for i in items), 'Missing label: ' + value)


def segment(index):
    frame = ui.element('list-segments')['frame']
    x = frame['x'] + frame['width'] * (0.25 if index == 0 else 0.75)
    ui.axe('tap', '-x', str(x), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '1')


subprocess.run(['xcrun', 'simctl', 'status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--wifiBars', '3', '--cellularBars', '4'], check=True)
try:
    ui.element('create-session-input')
    label('Fixture Agent')
    # The large detent hides the Debug list, whose scroll offset varies between launches.
    ui.axe('swipe', '--start-x', '201', '--start-y', '378', '--end-x', '201', '--end-y', '40', '--duration', '0.4', '--post-delay', '1.2')
    ui.capture('root-project')

    tap_id('model')
    ui.element('a')
    for tab in ['mode', 'more', 'model']:
        ui.axe('tap', '--label', catalog.text('model.tab.' + tab), '--post-delay', '1')
        ui.capture('model-' + tab)
    tap_id('a')
    ui.axe('tap', '--label', catalog.text('model.tab.effort'), '--post-delay', '1')
    ui.capture('model-effort')
    back()

    tap_id('agent')
    ui.element('ui:agent')
    ui.capture('agent-picker')
    back()

    tap_id('project')
    ui.element('ui:local:alpha')
    ui.capture('project-local')
    segment(1)
    ui.element('github:Owner/Repo1')
    ui.capture('project-github')
    back()

    ui.axe('tap', '--label', catalog.text('create.type.chat'), '--post-delay', '1')
    label('Fixture Agent')
    ui.capture('root-chat')
    tap_id('machine')
    ui.element('ui')
    ui.capture('machine-picker')
    back()
finally:
    subprocess.run(['xcrun', 'simctl', 'status_bar', udid, 'clear'], check=False)
print('PASS: captured new-session parity states; compare with parity-diff.py')
