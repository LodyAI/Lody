"""Offline comparison of public UIKit presentation/search capabilities, not product acceptance."""
import json
import signal
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(root / 'apps/ios/verification/ui'))
from driver import UI

udid, app, destination = sys.argv[1:]
output = Path(destination)
output.mkdir(parents=True, exist_ok=True)

def sim(*args):
    return subprocess.run(['xcrun', 'simctl', *args], check=True, capture_output=True, text=True, timeout=30)

sim('install', udid, app)
observations = []
for appearance in ('light', 'dark'):
    directory = output / appearance
    directory.mkdir(exist_ok=True)
    ui = UI(udid, directory)
    sim('ui', udid, 'appearance', appearance)
    sim('launch', '--terminate-running-process', udid, 'ai.lody.mobile.sidebar-poc', '-AppleLanguages', '(en)')
    ui.element('mode-0')
    (directory / 'flow.mp4').unlink(missing_ok=True)
    with (directory / 'recording.log').open('w') as log:
        recorder = subprocess.Popen(['xcrun', 'simctl', 'io', udid, 'recordVideo', '--codec=h264', str(directory / 'flow.mp4')], stderr=log)
        try:
            import time
            for _ in range(30):
                if 'Recording started' in (directory / 'recording.log').read_text(): break
                time.sleep(.1)
            else: raise RuntimeError('Recording did not start')
            ui.capture('system-search')
            column = ui.element('poc-column')['frame']
            for mode, name in enumerate(('system-sheet', 'source-sheet', 'compact-sheet', 'custom-sheet')):
                row = ui.element(f'mode-{mode}')['frame']
                ui.axe('tap', '-x', str(row['x'] + row['width'] / 2), '-y', str(row['y'] + row['height'] / 2), '--post-delay', '1')
                frame = ui.element('poc-form')['frame']
                ui.capture(name)
                observations.append({'appearance': appearance, 'mode': name, 'column': column, 'form': frame})
                if mode == 3:
                    assert abs(frame['x'] - column['x'] - 10) < 1, (frame, column)
                    assert abs(frame['width'] - column['width'] + 20) < 1, (frame, column)
                ui.axe('tap', '--label', 'close', '--post-delay', '.6')
            ui.axe('tap', '--id', 'mode-4', '--post-delay', '.8')
            frame = ui.element('bottom-search')['frame']
            assert frame['y'] > column['y'] + column['height'] - 100, (frame, column)
            ui.capture('glass-search')
            ui.axe('tap', '--label', 'Glass New Session', '--post-delay', '.8')
            ui.capture('glass-sheet-medium')
            medium = ui.element('poc-form')['frame']
            assert abs(medium['x'] - column['x'] - 10) < 1, (medium, column)
            assert not any(item.get('AXUniqueId') == 'bottom-search' for item in ui.state()), 'Background search leaked into the modal accessibility scope'
            handle = ui.element('poc-grabber')['frame']
            center = handle['x'] + handle['width'] / 2
            ui.axe('drag', '--start-x', str(center), '--start-y', str(handle['y'] + 2),
                   '--end-x', str(center), '--end-y', str(column['y'] + 8), '--duration', '.8', '--steps', '80', '--post-delay', '.6')
            expanded = ui.element('poc-form')['frame']
            for key in ('x', 'y', 'width', 'height'):
                assert abs(expanded[key] - column[key]) < 1, (expanded, column)
            ui.capture('glass-sheet-expanded')
            handle = ui.element('poc-grabber')['frame']
            ui.axe('drag', '--start-x', str(center), '--start-y', str(handle['y'] + 2),
                   '--end-x', str(center), '--end-y', str(medium['y'] + 8), '--duration', '.8', '--steps', '80', '--post-delay', '.6')
            collapsed = ui.element('poc-form')['frame']
            for key in ('x', 'y', 'width', 'height'):
                assert abs(collapsed[key] - medium[key]) < 1, (collapsed, medium)
            ui.capture('glass-sheet-collapsed')
            observations.append({'appearance': appearance, 'mode': 'detents', 'medium': medium, 'expanded': expanded, 'collapsed': collapsed})
            # Touch the former search location: the modal must receive it, not the search field.
            ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.4')
            ui.element('poc-form')
            assert not any(item.get('AXUniqueId') == 'bottom-search' for item in ui.state())
            ui.axe('tap', '--label', 'close', '--post-delay', '.6')
            ui.element('bottom-search')
            ui.axe('tap', '--id', 'bottom-search', '--post-delay', '.7')
            ui.axe('type', 'lody')
            if ui.element('bottom-search').get('AXValue') != 'lody':
                # The leased device may retain a pinyin IME from another offline scene.
                ui.axe('tap', '--label', 'Next keyboard', '--post-delay', '.3')
                ui.axe('tap', '--label', 'Clear text', '--post-delay', '.2')
                ui.axe('type', 'lody')
            assert ui.element('bottom-search').get('AXValue') == 'lody'
            ui.capture('glass-search-focused')
            observations.append({'appearance': appearance, 'mode': 'glass-search', 'column': column, 'search': frame})
        finally:
            recorder.send_signal(signal.SIGINT)
            recorder.wait(timeout=30)
    subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(directory / 'flow.mp4')], check=True)
(output / 'observations.json').write_text(json.dumps(observations, indent=2))
print('POC comparisons captured in both appearances; custom containment and bottom search placement passed.')
