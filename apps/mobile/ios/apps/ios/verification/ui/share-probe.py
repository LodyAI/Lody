"""Real system share sheet check for the Share Extension, with no login and no cloud.

python3 apps/ios/verification/ui/share-probe.py --app /path/to/Lody.app

Signed out: the extension loads with Lody stopped, explains sign-in and keeps Send
disabled. With a fixture App Group snapshot: the shared text fills the native form,
Send writes one inbox entry carrying the chosen agent, and Lody comes forward.
The model switch also carries an explicit false value into the shared draft.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import subprocess
import sys
import time

from driver import UI

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from simulator import SimulatorPool, run_with_simulator

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--app', required=True)
parser.add_argument('--udid', default=os.environ.get('LODY_VERIFY_UDID'))
parser.add_argument('--output', default='.artifacts/share-probe/ui')
parser.add_argument('--appearance', choices=['light', 'dark'], default='light')
parser.add_argument('--branches', action='store_true', help='Exercise cached GitHub branch selection and missing-cache handoff')
args = parser.parse_args()
if not args.udid:
    raise SystemExit(run_with_simulator(SimulatorPool(), 'Share Probe', [sys.executable, __file__, *sys.argv[1:]]))

app = Path(args.app).resolve()
assert (app / 'PlugIns/LodyShare.appex').is_dir(), 'Build the Share Extension target first'
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)


def sim(*command, **kwargs):
    return subprocess.run(['xcrun', 'simctl', *command], check=True, timeout=120, **kwargs)


host = output / 'ShareProbeHost.app'
host.mkdir(exist_ok=True)
(host / 'Info.plist').write_bytes(plistlib.dumps({
    'CFBundleIdentifier': 'ai.lody.mobile.share-probe-host',
    'CFBundleExecutable': 'ShareProbeHost',
    'CFBundleName': 'ShareProbeHost',
    'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': '1.0',
    'CFBundleVersion': '1',
    'MinimumOSVersion': '26.0',
    'LSRequiresIPhoneOS': True,
    'UIDeviceFamily': [1],
    'UILaunchScreen': {},
    'UIApplicationSceneManifest': {
        'UIApplicationSupportsMultipleScenes': False,
        'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [{
            'UISceneConfigurationName': 'Share Source',
            'UISceneDelegateClassName': 'ShareProbeHost.ShareProbeHostScene',
        }]},
    },
}))
sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
arch = 'arm64' if platform.machine() == 'arm64' else 'x86_64'
subprocess.run([
    'xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '6', '-parse-as-library', '-module-name', 'ShareProbeHost',
    '-sdk', sdk, '-target', f'{arch}-apple-ios26.0-simulator',
    str(Path(__file__).with_name('share-probe-host.swift')), '-o', str(host / 'ShareProbeHost'),
], check=True, timeout=120)
subprocess.run(['codesign', '--force', '--sign', '-', str(host)], check=True, timeout=30)
sim('install', args.udid, str(app))
sim('install', args.udid, str(host))
sim('ui', args.udid, 'appearance', args.appearance)
for bundle in ['ai.lody.mobile.share', 'ai.lody.mobile.share-probe-host']:
    sim('spawn', args.udid, 'defaults', 'write', bundle, 'AppleLanguages', '-array', 'en')
    sim('spawn', args.udid, 'defaults', 'write', bundle, 'AppleLocale', 'en_US')
group = Path(subprocess.check_output(
    ['xcrun', 'simctl', 'get_app_container', args.udid, 'ai.lody.mobile', 'group.ai.lody.mobile'], text=True).strip())
store = group / 'Library/LodyShare'
ui = UI(args.udid, output)


def flatten(node):
    yield node
    for child in node.get('children', []):
        yield from flatten(child)


def open_extension(name):
    # The containing app stays stopped; the system hosts only its extension.
    subprocess.run(['xcrun', 'simctl', 'terminate', args.udid, 'ai.lody.mobile'], capture_output=True, timeout=30)
    subprocess.run(['xcrun', 'simctl', 'terminate', args.udid, 'ai.lody.mobile.share-probe-host'], capture_output=True, timeout=30)
    sim('launch', args.udid, 'ai.lody.mobile.share-probe-host', '-AppleLanguages', '(en)', '-AppleLocale', 'en_US')
    ui.element('share-probe-host.open')
    ui.axe('tap', '--id', 'share-probe-host.open', '--tap-style', 'physical', '--post-delay', '1')
    ui.capture(f'{name}-tray')
    items = ui.state()
    if any(item.get('AXLabel') == 'Lody' for item in items):
        ui.axe('tap', '--label', 'Lody', '--tap-style', 'physical', '--post-delay', '1')
    else:
        # iOS 26.5's compact remote tray exposes only "dismiss popup" to AXe. Visually
        # confirmed 402x874 row: Reminders, Lody, More. A missed tap fails below.
        root = next(item for item in items if item.get('role') == 'AXApplication')
        assert root['frame']['width'] == 402 and root['frame']['height'] == 874
        ui.axe('tap', '-x', '156', '-y', '653', '--tap-style', 'physical', '--post-delay', '1')
    # Remote extension trees are hit-tested, not descendants of the source app.
    deadline = time.monotonic() + 30
    retried_tray = False
    while True:
        send = find_send()
        if send and send['frame']['y'] < 830:
            return send
        if not retried_tray and time.monotonic() > deadline - 25:
            items = ui.state()
            if any(item.get('AXLabel') in ['Lody', 'dismiss popup'] for item in items):
                ui.axe('tap', '-x', '156', '-y', '653', '--tap-style', 'physical', '--post-delay', '1')
            retried_tray = True
        if time.monotonic() >= deadline:
            ui.capture(f'{name}-unsettled')
            log = subprocess.run(['xcrun', 'simctl', 'spawn', args.udid, 'log', 'show', '--last', '2m', '--style', 'compact',
                '--predicate', 'process == "LodyShare" OR (eventMessage CONTAINS "LodyShare")'], capture_output=True, text=True, timeout=120)
            (output / f'{name}-extension.log').write_text(log.stdout)
            raise AssertionError('Extension did not settle')
        time.sleep(.2)


SEND_POINTS = ['362,808', '362,790', '200,808']


def find_send():
    for point in SEND_POINTS:
        nodes = list(flatten(json.loads(ui.axe('describe-ui', '--point', point))))
        send = next((n for n in nodes if n.get('AXUniqueId') == 'session-send'), None)
        if send:
            return send
    return None


def labels_at(*points):
    return [n.get('AXLabel') or '' for point in points for n in flatten(json.loads(ui.axe('describe-ui', '--point', point)))]


def remote(identifier, match=None):
    match = match or (lambda node: node.get('AXUniqueId') == identifier)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        for point in ['200,244', '200,320', '200,440', '200,580', '200,150']:
            nodes = list(flatten(json.loads(ui.axe('describe-ui', '--point', point))))
            item = next((n for n in nodes if match(n)), None)
            if item:
                return item
    (output / ('missing-' + identifier.replace(':', '-') + '.json')).write_text(json.dumps(nodes, indent=2))
    ui.capture('missing-remote-element')
    raise AssertionError('Missing remote extension element: ' + identifier)


def remote_tap(identifier):
    frame = remote(identifier)['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--tap-style', 'physical', '--post-delay', '.6')

def remote_back():
    nodes = list(flatten(json.loads(ui.axe('describe-ui', '--point', '30,112'))))
    button = next(n for n in nodes if n.get('type') == 'Button' and n.get('AXLabel') in ['Back', 'New Session'])
    frame = button['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--tap-style', 'physical', '--post-delay', '.6')


video = subprocess.Popen(['xcrun', 'simctl', 'io', args.udid, 'recordVideo', '--codec=h264', '--force', str(output / 'run.mp4')],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    shutil.rmtree(store, ignore_errors=True)
    send = open_extension('signed-out')
    assert send['enabled'] is False, 'Send must stay disabled without a snapshot'
    ui.capture('signed-out')
    assert any('sign in' in label for label in labels_at('200,300', '200,760')), 'Missing sign-in guidance'
    close = next((n for n in flatten(json.loads(ui.axe('describe-ui', '--point', '362,112'))) if n.get('AXLabel') == 'Close New Session'), None)
    assert close, 'Close button missing'
    ui.axe('tap', '-x', '362', '-y', '112', '--tap-style', 'physical', '--post-delay', '1')
    ui.element('share-probe-host.open')

    (store / 'options').mkdir(parents=True)
    project = {'id': 'ui:local:alpha', 'machineId': 'ui', 'name': 'Alpha', 'rootPath': '/tmp/alpha'}
    if args.branches:
        project = {'id': 'github:Owner/Repo', 'machineId': '', 'name': 'Owner/Repo', 'rootPath': ''}
        (store / 'branches').mkdir()
        (store / 'branches' / 'Owner%2FRepo.json').write_text(json.dumps({
            'names': ['trunk', 'feature/cached'], 'defaultBranch': 'trunk', 'nextPage': 2,
        }))
    (store / 'catalog.json').write_text(json.dumps({'userId': 'probe-user', 'workspaceId': 'probe-ws', 'projects': [project], 'machineNames': {'ui': 'Fixture Mac'}}))
    options = {'sessionId': 'cached', 'project': project, 'agents': [{'id': 'agent', 'name': 'Fixture Agent', 'machineId': 'ui', 'machineName': 'Fixture Mac', 'cliType': 'builtin', 'agentType': 'codex'}],
        'capabilities': [{'machineId': 'ui', 'cliType': 'builtin', 'agentType': 'codex', 'models': [{'id': 'a', 'name': 'Model A'}], 'modes': [], 'reasoningEfforts': {}, 'configOptions': [{'id': 'fast-mode', 'name': 'Fast mode', 'category': 'model_config', 'type': 'boolean', 'currentValue': False, 'options': []}]}]}
    from urllib.parse import quote
    for target in ['chat', quote(project['id'], safe='')]:
        (store / 'options' / f'{target}.json').write_text(json.dumps(options))
    send = open_extension('ready')
    deadline = time.monotonic() + 10
    while not send['enabled']:
        assert time.monotonic() < deadline, 'Send stayed disabled with a ready snapshot'
        time.sleep(.3)
        send = find_send() or send
    ui.capture('ready')
    remote_tap('model')
    # A point query returns only the leading segment, not the 'list-segments' container.
    tab = remote('model-tab', lambda node: node.get('role_description') == 'tab')['frame']
    ui.axe('tap', '-x', str(tab['x'] + tab['width'] * 1.5), '-y', str(tab['y'] + tab['height'] / 2), '--tap-style', 'physical', '--post-delay', '.6')
    assert remote('fast-mode:toggle').get('AXValue') == '0'
    for enabled in [True, False]:
        ui.tap_switch(remote('fast-mode:toggle'))
        expected = '1' if enabled else '0'
        assert remote('fast-mode:toggle').get('AXValue') == expected, 'Extension model switch did not update'
        ui.capture('model-fast-' + ('on' if enabled else 'off'))
    remote_back()
    send = find_send()
    assert send and send['enabled'], 'Changing model options must keep the share ready'
    if args.branches:
        assert 'trunk' in str(remote('branch')), 'Cached default must be chosen in the extension'
        remote_tap('branch')
        remote('branch:trunk')
        remote('branches-cached')
        ui.capture('cached-branches')
        remote_tap('list-search')
        ui.axe('type', 'cached')
        assert (remote('list-search').get('AXValue') or '').casefold() == 'cached', 'Search lost characters while refreshing'
        remote('branch:feature/cached')
        ui.capture('cached-search')
        remote_tap('branch:feature/cached')
        assert 'feature/cached' in str(remote('branch'))
        ui.capture('cached-selected')
        send = find_send()
        assert send and send['enabled']
    frame = send['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--tap-style', 'physical', '--post-delay', '3')
    entries = [json.loads((entry / 'manifest.json').read_text()) for entry in (store / 'inbox').iterdir()]
    assert len(entries) == 1, f'Expected one inbox entry, found {len(entries)}'
    entry = entries[0]
    assert 'Lody share probe' in entry['text'], 'Shared text must reach the manifest'
    assert entry['draft']['agent']['id'] == 'agent' and entry['draft']['sessionId'] != 'cached', 'Draft must carry the agent and a fresh session id'
    assert entry['draft']['choice']['configOptionValues']['fast-mode'] is False, 'Explicit false model option must reach the share inbox'
    if args.branches:
        assert entry['draft']['branch'] == 'feature/cached', 'Selected branch must reach the inbox draft'
    (output / 'manifest.json').write_text(json.dumps(entry, indent=2))
    deadline = time.monotonic() + 12
    while any(item.get('AXUniqueId') == 'share-probe-host.open' for item in ui.state()):
        if time.monotonic() >= deadline:
            ui.capture('handoff-missing')
            log = subprocess.run(['xcrun', 'simctl', 'spawn', args.udid, 'log', 'show', '--last', '2m', '--style', 'compact',
                '--predicate', 'process == "LodyShare" OR eventMessage CONTAINS[c] "lody" OR eventMessage CONTAINS[c] "openURL"'], capture_output=True, text=True, timeout=120)
            (output / 'handoff-extension.log').write_text(log.stdout)
            raise AssertionError('Lody did not come forward')
        time.sleep(.5)
    ui.capture('handoff')
    if args.branches:
        shutil.rmtree(store / 'branches')
        shutil.rmtree(store / 'inbox', ignore_errors=True)
        send = open_extension('missing-cache')
        remote_tap('branch')
        remote('branches-cached')
        ui.capture('missing-cache')
        # Back belongs to the remote extension's own navigation stack.
        remote_back()
        send = find_send()
        assert send and send['enabled'], 'No branch cache must still allow handoff to the app'
        frame = send['frame']
        ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--tap-style', 'physical', '--post-delay', '3')
        entries = [json.loads((entry / 'manifest.json').read_text()) for entry in (store / 'inbox').iterdir()]
        assert len(entries) == 1 and entries[0].get('draft') is None and 'Lody share probe' in entries[0]['text'], 'Missing branch must preserve text and defer resolution'
        (output / 'unresolved-manifest.json').write_text(json.dumps(entries[0], indent=2))
    print('PASS: signed-out guidance, ready snapshot form, inbox entry written, Lody opened')
    print('NOT VERIFIED: authenticated drain into the outbox (covered by tests/share and a signed-in device run)')
finally:
    video.send_signal(signal.SIGINT)
    video.wait(timeout=20)
    shutil.rmtree(store, ignore_errors=True)
