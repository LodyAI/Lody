"""Real WebView lifecycle and short UIKit background allowance; no cloud or credentials."""
import json
from pathlib import Path
import subprocess
import sys
import time
from driver import UI

udid, output = sys.argv[1:3]
ui = UI(udid, output)
evidence = []

def state(items):
    row = next((i for i in items if i.get('AXUniqueId') == 'background-status'), {})
    return json.loads(row.get('AXValue') or row.get('AXLabel') or '{}')

def wait(predicate, label):
    value = ui.wait(lambda items: state(items) if predicate(state(items)) else None, label)
    evidence.append({'step': label, **value})
    return value

def tap(name):
    ui.axe('tap', '--id', 'background-' + name, '--tap-style', 'physical')

def foreground():
    subprocess.run(['xcrun', 'simctl', 'launch', udid, 'ai.lody.mobile'], check=True, timeout=30)

try:
    tap('start')
    initial = wait(lambda s: s.get('state') == 'live' and s.get('updates', 0) > 0, 'fixture ready')
    ui.capture('connected')
    ui.axe('button', 'home')
    time.sleep(5)
    foreground()
    returned = wait(lambda s: s.get('updates', 0) > initial['updates'], 'callbacks resume after background')
    assert returned['generation'] == initial['generation'], 'Background destroyed the WebView'
    ui.capture('retained')
    tap('send')
    submitted = wait(lambda s: s.get('task') == 'running' and s.get('tasks') == 1, 'short background allowance granted')
    ui.capture('task-started')
    ui.axe('button', 'home')
    time.sleep(2)
    ui.capture('background')
    ui.axe('button', 'lock')
    time.sleep(2)
    ui.capture('lockscreen-no-sync-activity')
    ui.axe('button', 'lock')
    time.sleep(1)
    ui.axe('swipe', '--start-x', '200', '--start-y', '780', '--end-x', '200', '--end-y', '300', '--duration', '0.4', '--post-delay', '1.0')
    foreground()
    resumed = wait(lambda s: s.get('updates', 0) > submitted['updates'], 'callbacks resume after sending in background')
    assert resumed['generation'] == initial['generation'], 'Resume rebuilt a healthy WebView'
    ui.capture('after-background')
    tap('complete')
    wait(lambda s: s.get('tasks') == 0 and s.get('task') == 'completed', 'completed reply releases allowance')
    ui.capture('completed')
    tap('send')
    wait(lambda s: s.get('task') == 'running' and s.get('tasks') == 1, 'new user send starts fresh allowance')
    tap('expire')
    wait(lambda s: s.get('task') == 'expired' and s.get('tasks') == 0, 'expiration releases allowance')
    ui.capture('expired')
    tap('complete')
    time.sleep(2)
    wait(lambda s: s.get('tasks') == 0 and s.get('task') == 'expired', 'late stream updates do not restart expired allowance')
    tap('send')
    wait(lambda s: s.get('tasks') == 1, 'send after expiration remains usable')
    tap('stop')
    wait(lambda s: s.get('state') == 'stopped', 'explicit stop releases runtime')
    print('PASS: retained WebView, short background allowance, completion, expiration, late updates and stop', flush=True)
finally:
    Path(output, 'background-evidence.json').write_text(json.dumps(evidence, indent=2))
