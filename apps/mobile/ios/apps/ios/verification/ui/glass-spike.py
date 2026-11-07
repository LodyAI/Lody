"""Isolated UIKit material experiment; run inside verify:simulator after verify:build."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

from driver import UI

udid = os.environ['LODY_VERIFY_UDID']
app, destination = sys.argv[1:]
output = Path(destination).resolve()
output.mkdir(parents=True, exist_ok=True)


def sim(*args):
    return subprocess.check_output(['xcrun', 'simctl', *args], text=True, timeout=30).strip()


sim('install', udid, app)
for appearance in ('light', 'dark'):
    directory = output / appearance
    directory.mkdir(exist_ok=True)
    ui = UI(udid, directory)
    sim('ui', udid, 'appearance', appearance)
    sim('launch', '--terminate-running-process', udid, 'ai.lody.mobile', '--ui-verify', '--glass-spike')
    ui.element('glass-spike-run')
    ui.capture('initial')
    with (directory / 'recording.log').open('w') as log:
        recorder = subprocess.Popen(['xcrun', 'simctl', 'io', udid, 'recordVideo', '--codec=h264', str(directory / 'flow.mp4')], stderr=log)
        try:
            for _ in range(50):
                if 'Recording started' in (directory / 'recording.log').read_text():
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Recording failed to start')
            ui.axe('tap', '--id', 'glass-spike-run', '--post-delay', '.1')
            time.sleep(2.2)
            ui.capture('dematerialized')
            time.sleep(7.5)
            assert ui.element('glass-spike-phase').get('AXLabel') == 'Spike complete'
            ui.capture('restored-after-reversal')
        finally:
            recorder.send_signal(signal.SIGINT)
            recorder.wait(timeout=30)
    container = Path(sim('get_app_container', udid, 'ai.lody.mobile', 'data'))
    shutil.copy2(container / 'Documents/glass-spike.json', directory / 'observations.json')
    report = json.loads((directory / 'observations.json').read_text())
    assert report['events'][-1]['event'] == 'final-visible-after-reversal'
    hidden = next(item for item in report['events'] if item['event'] == 'settled-false')
    assert all(not surface['interactive'] for surface in hidden['surfaces'])
    assert all(surface['effect'] == 'nil' and not surface['hidden'] and surface['alpha'] == 1
               for surface in hidden['surfaces'][2:3]), 'Material must disappear without hiding its host'
    assert hidden['surfaces'][3]['hidden'] and hidden['surfaces'][3]['effect'] == 'nil'
    print(appearance, report['system'], 'hidden effects:', [s['effect'] for s in hidden['surfaces']], flush=True)
