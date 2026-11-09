"""Run offline UI baselines on a managed Simulator lease; see README.md."""
import argparse
import json
import os
from pathlib import Path
import signal
import select
import shutil
import subprocess
import sys
import time
from orchestrator import run_batches
from driver import UI, allow_custom_scheme, launch_covered
import pad as pad_motion

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from simulator import DEVICE_TYPES, run_with_simulator, SimulatorPool

CHAT = ROOT / 'apps/ios/verification/kit/chat'
# Each retained scene owns its services in Swift and exercises production controllers.
BATCHES = {
    'pages': ['onboarding', 'home', 'home-settings', 'home-workspace', 'schedules', 'home-states', 'navigation', 'licenses', 'create-parity', 'model-memory', 'project-picker', 'branch-picker', 'project-history', 'project-history-entry', 'directory', 'project', 'activity', 'notifications', 'diagnostics', 'settings-baseline', 'preferences', 'queued-message-behavior'],
    'send': ['send', 'send-queue', 'send-guide', 'send-interrupt', 'send-rounds', 'send-scroll-guide', 'send-scroll-queue', 'send-scroll-normal', 'session-native', 'session-simulator', 'permission-native', 'item-details', 'edit-message', 'session-share', 'agent-error', 'native-diff', 'native-workspace-changes', 'native-file-content'],
    'settings': ['agents-settings', 'prompt-shortcuts', 'project-visibility', 'github-settings', 'ai-usage', 'published-shares', 'published-share-states', 'agent-roles', 'archived-sessions'],
}
SUITES = {
    'settings-workspace': BATCHES['settings'],
    'guidance-scroll': ['send-scroll-normal', 'send-scroll-guide', 'send-scroll-queue'],
    'core': ['onboarding', 'home-settings', 'navigation', 'send', 'session-native', 'create-parity'],
    'core-home': ['onboarding', 'home-settings', 'navigation'],
    'core-send': ['send', 'session-native', 'create-parity'],
    'send-reliability': ['send-guide', 'send-queue', 'send-interrupt', 'send'],
}
CORE_SUITES = {name for name in SUITES if name.startswith('core')}
PHONE_CASES = [case for batch in BATCHES.values() for case in batch]
PAD_CASES = ['devices-pad', 'session-delete-pad', 'ipad', 'ipad-create', 'ipad-chrome', 'ipad-sidebar', 'session-search-pad', 'wide-panel', 'pad-layout']
CASES = PHONE_CASES + PAD_CASES + ['toast', 'session-delete', 'session-search', 'devices', 'workspace-general', 'morph', 'sheet-zoom-project', 'mentions-production']
HOME_CASES = {'schedules', 'home-states', 'session-search', 'session-search-pad', 'morph', 'sheet-zoom-project', 'mentions-production', 'home', 'home-settings', 'home-workspace', 'licenses', 'navigation', 'project-history-entry', 'ipad', 'ipad-create', 'ipad-chrome', 'ipad-sidebar', 'wide-panel', 'pad-layout', 'session-delete', 'session-delete-pad', 'devices', 'devices-pad', 'workspace-general'}
PREVIEW = {
    'toast': 'session-preview-live',
    'role-mention-chat': 'mention-chat',
    'role-mention-sheet': 'mention-sheet',
    'agent-roles': 'agent-roles-preview',
    'archived-sessions': 'archived-sessions-preview',
    'session-native': 'session-preview-live',
    'session-simulator': 'session-preview-live',
    'permission-native': 'permission-native-preview',
    'native-diff': 'file-diff-preview',
    'native-workspace-changes': 'workspace-changes-preview',
    'native-file-content': 'file-content-preview',
    'published-shares': 'published-shares-preview',
    'published-share-states': 'published-shares-readonly',
    'ai-usage': 'ai-usage-preview',
    'github-settings': 'github-settings-preview',
    'project-visibility': 'project-visibility-preview',
    'prompt-shortcuts': 'prompt-shortcuts-preview',
    'agents-settings': 'settings-preview',
    'settings-form-backgrounds': 'settings-forms-preview',
    'machine-settings': 'machine-settings-preview',
    'settings-baseline': 'settings-baseline-live',
    'mermaid': 'mermaid-preview',
    'workspace-changes': 'simulator-preview',
    'simulator-preview': 'simulator-preview',
    'item-details': 'item-detail-preview',
    'message-details': 'message-share-preview',
    'edit-message': 'edit-message-preview',
    'free-turn-notice': 'free-turn-notice-preview',
    'camera-chat': 'composer-success',
    'camera-sheet': 'composer-preview',
    'session-tree': 'session-tree-preview',
    'session-tree-pad': 'session-tree-preview',
    'message-share': 'message-share-preview',
    'session-share': 'session-share-preview',
    'reply-haptics': 'reply-haptics-preview',
    'scroll-edge': 'chat-preview',
    'scroll-edge-pages': 'scroll-edge-pages',
    'scroll-edge-diff': 'scroll-edge-diff',
    'proposed-plan': 'proposed-plan-preview',
    'agent-error': 'agent-error-preview',
    'outbox': 'outbox-preview',
    'composer-relay': 'composer-relay',
    'native-collection': 'native-collection-poc',
    'pull-request': 'pull-request-preview',
    'mention-chat': 'mention-chat',
    'mention-sheet': 'mention-sheet',
    'send-transition': 'send-preview',
    'send-transition-handoff': 'send-handoff',
    'notifications': 'notification-preview',
    'diagnostics': 'diagnostics-preview',
    'send-queue': 'send-queue',
    'steer': 'steer-preview',
    'send-guide': 'send-guide',
    'send-scroll-normal': 'send-scroll-normal',
    'send-scroll-guide': 'send-scroll-guide',
    'send-scroll-queue': 'send-scroll-queue',
    'send-interrupt': 'send-interrupt',
    'send-rounds': 'send-preview',
    'user-mentions': 'file-preview',
    'file-preview': 'file-preview',
    'html-preview': 'file-preview',
    'file-selection': 'file-preview',
    'mcp-files': 'file-preview',
    'chat-performance': 'chat-performance',
    'chat-stream-performance': 'chat-stream-performance',
    'project-history': 'project-history-preview',
    'directory': 'directory-preview',
    'project': 'project-preview',
    'activity': 'activity-preview',
    'project-picker': 'project-picker-preview',
    'branch-picker': 'create-parity',
    'settings': 'settings-preview',
    'preferences': 'preferences-preview',
    'queued-message-behavior': 'queued-message-behavior-preview',
    'model-memory': 'model-memory',
    'create-parity': 'create-parity',
    'smooth-scroll': 'scroll-preview',
    'duration': 'permission-preview',
    'process-counts': 'chat-preview',
    'title-rename': 'chat-preview',
    'process-failed': 'chat-preview',
    'chat-chrome': 'chat-preview',
    'send': 'send-preview',
    'send-handoff': 'send-handoff',
    'send-handoff-delayed': 'send-handoff-delayed',
    'background': 'background-preview',
    'attachment-motion-chat': 'composer-success',
    'attachment-motion-sheet': 'composer-preview',
    'attachment-motion-create': 'create-parity',
    'attachment-camera-chat': 'composer-success',
    'attachment-camera-sheet': 'composer-preview',
    'attachment-overlay-chat': 'composer-success',
    'attachment-overlay-sheet': 'composer-preview',
    'attachment-overlay-create': 'create-parity',
    'paste-plain-sheet': 'composer-preview',
    'paste-plain-chat': 'composer-success',
    'rich-paste-sheet': 'composer-preview',
    'rich-paste-chat': 'chat-preview',
    'composer': 'composer-preview',
    'composer-glass': 'composer-preview',
    'permission-mode-chat': 'mention-chat',
    'permission-mode-sheet': 'mention-sheet',
    'permission-mode-create': 'create-parity',
    'fast-chat': 'chat-preview',
    'fast-sheet': 'composer-preview',
    'composer-glass-chat': 'composer-success',
    'composer-rest-draft': 'composer-success',
    'composer-video': 'composer-success',
    'composer-success': 'composer-success',
    'composer-failure': 'composer-failure',
    'composer-rich': 'composer-preview',
    'composer-fullscreen': 'composer-success',
    'inbox': 'inbox-preview',
    'onboarding': 'onboarding-preview',
    'community-notice': 'community-notice',
}
READY = {
    'toast': 'session-preview-probe',
    'role-mention-sheet': 'create-session-input',
    'agent-roles': 'list-unavailable-action',
    'archived-sessions': 'archived-preview-writes',
    'session-native': 'session-preview-probe',
    'session-simulator': 'session-preview-probe',
    'permission-native': 'permission-preview-probe',
    'native-diff': 'diff-preview:changes:docs/superpowers/.diff-check.md',
    'native-workspace-changes': 'file:src/greeting.ts',
    'native-file-content': 'file:report.md',
    'published-shares': 'list-unavailable-action',
    'published-share-states': 'share:own',
    'ai-usage': 'list-unavailable-action',
    'github-settings': 'list-unavailable-action',
    'project-visibility': 'visibility:m1:same',
    'prompt-shortcuts': 'list-unavailable-action',
    'agents-settings': 'settings-agent',
    'settings-form-backgrounds': 'form-machine',
    'machine-settings': 'list-notice-action',
    'settings-baseline': 'settings-baseline-ready',
    'mermaid': 'mermaid-preview:text',
    'item-details': 'item-detail-retry-item',
    'message-details': 'paper-reply:meta:details',
    'free-turn-notice': 'free-turn-24',
    'camera-chat': 'session-input',
    'camera-sheet': 'create-session-input',
    'session-tree': 'tree-root',
    'session-tree-pad': 'tree-root',
    'message-share': 'paper-reply:meta:actions',
    'session-share': 'open-session-share',
    'reply-haptics': 'reply-haptics-start',
    'scroll-edge': 'session-input',
    'scroll-edge-pages': 'create-session-input',
    'scroll-edge-diff': 'scroll-edge-diff-toolbar',
    'proposed-plan': 'plan-preview:document',
    'agent-error': 'error-system:failure:title',
    'outbox': 'outbox-state',
    'composer-relay': 'composer-relay-open',
    'native-collection': 'poc-native-collection',
    'pull-request': 'session-input',
    'mention-chat': 'session-input',
    'mention-sheet': 'create-session-input',
    'send-transition': 'send-status',
    'send-transition-handoff': 'create-session-input',
    'notifications': 'notification-preview-ready',
    'diagnostics': 'diagnostics-count',
    'send-queue': 'send-status',
    'steer': 'steer-next',
    'send-guide': 'send-status',
    'send-scroll-normal': 'send-status',
    'send-scroll-guide': 'send-status',
    'send-scroll-queue': 'send-status',
    'send-interrupt': 'send-status',
    'send-rounds': 'send-status',
    'user-mentions': 'file-links:answer',
    'file-preview': 'file-links:answer',
    'html-preview': 'file-links:answer',
    'file-selection': 'file-links:answer',
    'mcp-files': 'file-links:answer',
    'project-history': 'history-project:["studio","demo"]',
    'directory': 'studio',
    'project': 'project-live',
    'activity': 'activity-running',
    'project-picker': 'create-session-input',
    'branch-picker': 'create-session-input',
    'settings': 'settings-machine',
    'preferences': 'app-icon',
    'queued-message-behavior': 'queued-message-behavior',
    'model-memory': 'create-session-input',
    'create-parity': 'create-session-input',
    'send': 'send-status',
    'send-handoff': 'create-session-input',
    'send-handoff-delayed': 'create-session-input',
    'background': 'background-status',
    'attachment-motion-chat': 'session-input',
    'attachment-motion-sheet': 'create-session-input',
    'attachment-motion-create': 'create-session-input',
    'attachment-camera-chat': 'session-input',
    'attachment-camera-sheet': 'create-session-input',
    'attachment-overlay-chat': 'session-input',
    'attachment-overlay-sheet': 'create-session-input',
    'attachment-overlay-create': 'create-session-input',
    'paste-plain-sheet': 'create-session-input',
    'paste-plain-chat': 'session-input',
    'rich-paste-sheet': 'create-session-input',
    'rich-paste-chat': 'session-input',
    'composer': 'create-session-input',
    'composer-glass': 'create-session-input',
    'permission-mode-chat': 'session-input',
    'permission-mode-sheet': 'create-session-input',
    'permission-mode-create': 'create-session-input',
    'fast-chat': 'session-input',
    'fast-sheet': 'create-session-input',
    'composer-glass-chat': 'session-input',
    'composer-rest-draft': 'session-input',
    'composer-video': 'session-input',
    'composer-success': 'session-input',
    'composer-failure': 'session-input',
    'composer-rich': 'create-session-input',
    'composer-fullscreen': 'session-input',
    'inbox': 'inbox-wait',
    'onboarding': 'auth.native.github',
    'community-notice': 'community-notice',
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    '--udid',
    default=os.environ.get('LODY_VERIFY_UDID') or None,
    help='Existing Simulator; omit to lease a clean Lody Verify Simulator',
)
parser.add_argument('--app', required=True, type=Path)
parser.add_argument('--output', type=Path, default=ROOT / '.artifacts/ui')
selection = parser.add_mutually_exclusive_group()
selection.add_argument('--case', choices=CASES)
selection.add_argument('--batch', choices=BATCHES)
selection.add_argument('--suite', choices=SUITES, help='Named case set; core* is the PR regression')
selection.add_argument('--parallel', action='store_true', help='Run native batches on separate leased Simulators')
parser.add_argument('--camera-access', choices=['fixture', 'allow', 'deny'], default='fixture', help='Camera capture fixture or real system permission return')
parser.add_argument('--photo-access', choices=['full', 'limited', 'denied', 'settings', 'granted'], default='full', help='Real system Photos permission outcome for attachment overlay cases')
parser.add_argument('--language', choices=['en'], default='en', help='UI verification runs in English only')
parser.add_argument('--appearance', choices=['light', 'dark'], help='One appearance; omit to run light and dark, or light only for --suite core')
parser.add_argument('--fail-fast', action='store_true', help='Stop after the first failed case')
parser.add_argument(
    '--embedded',
    action='store_true',
    help=argparse.SUPPRESS,
)
parser.add_argument(
    '--require-video',
    action=argparse.BooleanOptionalAction,
    default=None,
    help='Require a captured run.mp4; --suite core defaults to off',
)
args = parser.parse_args()
if args.parallel and args.udid:
    parser.error('--parallel owns its Simulator leases; omit --udid')
os.environ['LODY_UI_PHOTO_ACCESS'] = args.photo_access
os.environ['LODY_UI_CAMERA_ACCESS'] = args.camera_access
args.output = args.output.resolve()
# Stale evidence is replaced in place; only a run needing A/B comparison picks a different --output.
if any((args.output / marker).exists() for marker in ['results.json', 'batches.json', 'environment.json']):
    shutil.rmtree(args.output)
args.output.mkdir(parents=True, exist_ok=True)
if args.parallel:
    commands = {
        batch: [sys.executable, __file__, '--app', str(args.app.resolve()), '--batch', batch,
                '--output', str(args.output / batch),
                '--language', args.language, '--camera-access', args.camera_access, '--photo-access', args.photo_access, '--embedded']
        for batch in BATCHES
    }
    raise SystemExit(run_batches(commands, args.output))
selected = PHONE_CASES
if args.suite:
    selected = SUITES[args.suite]
elif args.batch:
    selected = BATCHES[args.batch]
elif args.case:
    selected = [args.case]
core_suite = args.suite in CORE_SUITES
if args.appearance:
    appearances = [args.appearance]
elif core_suite:
    appearances = ['light']
else:
    appearances = ['light', 'dark']
if args.fail_fast:
    fail_fast = True
else:
    fail_fast = core_suite
if args.require_video is None:
    require_video = not core_suite
else:
    require_video = args.require_video
if args.udid is None:
    verify_name = f'UI {args.batch}' if args.batch else 'UI'
    if args.suite is not None:
        verify_name = f'UI {args.suite}'
    if args.case is not None:
        verify_name = args.case.replace('-', ' ').title()
    command = [sys.executable, __file__, *sys.argv[1:]]
    device_type = DEVICE_TYPES['ipad'] if args.case in PAD_CASES else DEVICE_TYPES['iphone']
    raise SystemExit(
        run_with_simulator(
            SimulatorPool(device_type=device_type), verify_name, command
        )
    )
def sim(*command, check=True, timeout=60):
    # A freshly booted iOS 27 Simulator can ignore the first spawn for a minute.
    last = None
    for _ in range(3):
        try:
            return subprocess.run(['xcrun', 'simctl', *command], check=check, timeout=timeout, capture_output=True, text=True)
        except subprocess.TimeoutExpired as error:
            last = error
            time.sleep(2)
    raise last

def terminate_app():
    # Reinstall/reset can already have stopped the app. Some runtime versions
    # wait indefinitely when asked to terminate an absent UIKit process.
    running = sim('spawn', args.udid, 'launchctl', 'list').stdout.splitlines()
    if any(line.split()[0].isdigit() and 'UIKitApplication:ai.lody.mobile[' in line for line in running):
        sim('terminate', args.udid, 'ai.lody.mobile', check=False)

results = []
links_ready = False
# Each worker owns only its Simulator lease and native app process.
try:
    (args.output / 'environment.json').write_text(json.dumps({
        'node': subprocess.check_output(['node', '--version'], text=True).strip(),
        'batch': args.batch, 'suite': args.suite, 'cases': selected, 'appearances': appearances,
        'failFast': fail_fast, 'requireVideo': require_video, 'native': True,
        'udid': args.udid, 'app': str(args.app.resolve()), 'language': args.language,
        'photoAccess': args.photo_access, 'cameraAccess': args.camera_access,
        'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'worktreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
        'xcode': subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
        'axe': subprocess.check_output(['axe', '--version'], text=True).strip(),
    }, indent=2))
    sim('spawn', args.udid, 'defaults', 'write', 'com.apple.keyboard.preferences', 'AutomaticMinimizationEnabled', '-bool', 'false')
    # A Chinese App Language otherwise brings up the pinyin IME, which buffers typed
    # fixture text as composition instead of committing it to the field.
    sim('spawn', args.udid, 'defaults', 'write', 'com.apple.Preferences', 'AppleKeyboards', '-array', 'en_US@sw=QWERTY')
    # A pending autocorrection is accepted by the next touch anywhere outside the field, so
    # typed fixture text would change with whatever the keyboard has learned on this device.
    sim('spawn', args.udid, 'defaults', 'write', 'com.apple.keyboard.preferences', 'KeyboardAutocorrection', '-bool', 'false')
    keyboard = args.output / 'software-keyboard'
    subprocess.run(['xcrun', 'clang', '-fobjc-arc', '-framework', 'Foundation', str(Path(__file__).with_name('software-keyboard.m')), '-o', str(keyboard)], check=True, timeout=60)
    subprocess.run([str(keyboard), subprocess.check_output(['xcode-select', '-p'], text=True).strip(), args.udid], check=True, timeout=30)
    sim('install', args.udid, str(args.app.resolve()))
    if 'workspace-general' in selected or any(case.startswith('attachment-motion-') for case in selected) or (args.photo_access in ['full', 'limited', 'granted'] and any(case.startswith('attachment-overlay-') for case in selected)):
        # Photos outlives app launches. Seed once per app container so repeats
        # don't fill the grid with duplicates or reinitialize the photo service.
        container = Path(sim('get_app_container', args.udid, 'ai.lody.mobile', 'data').stdout.strip())
        seeded = container / 'Library/Caches/lody-ui-photo-fixture-v3'
        if not seeded.exists():
            terminate_app()
            # Enough rows to exercise layout changes while scrolled.
            fixtures = args.output / 'photo-fixtures'
            fixtures.mkdir(parents=True, exist_ok=True)
            photos = []
            for index in range(12):
                photo = fixtures / f'photo-{index}.png'
                shutil.copyfile(ROOT / 'apps/ios/App/Icons.xcassets/AppIconPreview-default.imageset/default.png', photo)
                photos.append(str(photo.resolve()))
            sim('addmedia', args.udid, *photos, timeout=120)
            seeded.parent.mkdir(parents=True, exist_ok=True)
            seeded.touch()
    sim('ui', args.udid, 'content_size', 'large')
    cases = sorted(HOME_CASES.intersection(selected)) + [case for case in selected if case not in HOME_CASES]
    launch_mode = None
    app_pid = None
    trace_throw = any(case.startswith('send-scroll-') for case in selected) or bool(set(selected).intersection({'send-transition', 'send-transition-handoff', 'send', 'send-handoff', 'send-handoff-delayed', 'send-rounds', 'send-queue', 'steer', 'send-guide', 'ipad-chrome'}))
    for appearance in appearances:
        sim('ui', args.udid, 'appearance', appearance)
        for case in cases:
            output = args.output / appearance / case
            ui = UI(args.udid, output)
            recording = None
            started = time.monotonic()
            result = {'case': case, 'appearance': appearance, 'language': args.language, 'status': 'failed'}
            try:
                if case.startswith('attachment-camera-') or case in ('camera-chat', 'camera-sheet'):
                    terminate_app()
                    launch_mode = None
                    if args.camera_access != 'fixture':
                        sim('privacy', args.udid, 'reset', 'camera', 'ai.lody.mobile')
                if case.startswith(('attachment-overlay-', 'attachment-motion-')):
                    terminate_app()
                    grant_photos = case.startswith('attachment-motion-') or args.photo_access == 'granted'
                    sim('privacy', args.udid, 'grant' if grant_photos else 'reset', 'photos', 'ai.lody.mobile')
                    launch_mode = None
                mode = (case in HOME_CASES, case in ('smooth-scroll', 'chat-performance'), case in ('camera-chat', 'camera-sheet'))
                if case == 'chat-performance':
                    container = Path(sim('get_app_container', args.udid, 'ai.lody.mobile', 'data').stdout.strip())
                    (container / 'tmp/lody-chat-loading.json').unlink(missing_ok=True)
                restart = True
                if restart:
                    result['appLifecycle'] = 'launch'
                    terminate_app()
                    launch = ['launch', args.udid, 'ai.lody.mobile', '--ui-verify']
                    if case in HOME_CASES:
                        launch.append('--ui-verify-home')
                    if case in {'session-search', 'session-search-pad'}:
                        launch.append('--ui-verify-search')
                    if case in {'morph', 'sheet-zoom-project', 'mentions-production', 'home', 'home-settings', 'home-workspace', 'ipad', 'ipad-create', 'ipad-chrome', 'ipad-sidebar'}:
                        launch.append('--ui-verify-mentions')
                    if mode[2] or (case.startswith('attachment-camera-') and args.camera_access == 'fixture'):
                        sim('privacy', args.udid, 'reset', 'photos', 'ai.lody.mobile')
                        launch.append('--ui-verify-camera')
                    if case.startswith('attachment-motion-'):
                        launch.append('--ui-verify-camera')
                    if mode[1]:
                        launch.append('--ui-verify-scroll')
                    if case == 'navigation-toolbar':
                        launch.append('--ui-verify-opening')
                    if trace_throw:
                        launch.append('--ui-verify-throw')
                    launch += [
                        '-AppleLanguages', f'({args.language})',
                        '-AppleLocale', 'en_US',
                        '-AppleKeyboards', '(en_US@sw=QWERTY)',
                    ]
                    sim(*launch)
                    launch_mode = mode
                processes = sim('spawn', args.udid, 'launchctl', 'list').stdout.splitlines()
                result['appPid'] = next((line.split()[0] for line in processes if 'UIKitApplication:ai.lody.mobile[' in line), None)
                assert result['appPid'], 'Lody process is missing'
                if result['appLifecycle'] == 'return-to-root':
                    assert result['appPid'] == app_pid, 'Returning to root unexpectedly replaced the App process'
                app_pid = result['appPid']
                activated = time.monotonic()

                def verify_ready(items):
                    global activated
                    if any(item.get('AXUniqueId') == 'ui-verify-ready' for item in items):
                        return True
                    # A cold AXe session can resign the app to SpringBoard before
                    # the first tree arrives. Bring it forward again, then keep waiting.
                    if launch_covered(items, result.get('appPid')) and time.monotonic() - activated >= 5:
                        activated = time.monotonic()
                        sim(*launch)
                    return False

                ui.wait(verify_ready, 'Missing ui-verify-ready', timeout=180)
                if not links_ready:
                    sim('openurl', args.udid, 'lody:///')
                    allow_custom_scheme(ui)
                    ui.element('ui-verify-ready')
                    links_ready = True
                if require_video:
                    recording = subprocess.Popen(['xcrun', 'simctl', 'io', args.udid, 'recordVideo', '--codec=hevc', str(output / 'run.mp4')], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        if select.select([recording.stderr], [], [], .5)[0]:
                            line = recording.stderr.readline()
                            if b'Recording started' in line:
                                (output / 'run-video-started').write_text(str(time.time()))
                                break
                            if not line:
                                raise RuntimeError('Video recorder exited before its first frame')
                    else:
                        raise TimeoutError('Video recorder did not start')
                preview = PREVIEW.get(case, 'chat-preview')
                ready = 'ui-verify-ready' if case in HOME_CASES else READY.get(case, 'session-input')
                entry_started = time.monotonic()
                if case not in HOME_CASES:
                    ui.open_case(preview)
                    result['caseEntry'] = 'deep-link'
                ui.element(ready)
                result['caseEntrySeconds'] = round(time.monotonic() - entry_started, 2)
                if case == 'permission':
                    ui.wait(lambda items: any(i.get('AXLabel') == 'Fixtures' for i in items), 'Missing permission fixture toolbar')
                if case == 'image-preview':
                    ui.axe('tap', '--label', 'Fixtures')
                    ui.axe('tap', '--label', 'Image Fixture')
                    ui.element('preview-image:attachment:ui-verify-image')
                ui.capture('before')
                script = Path(__file__).with_name(f'{case}.py') if case in ['toast', 'workspace-changes', 'simulator-preview', 'item-details', 'message-details', 'message-share', 'pull-request', 'project-history-entry', 'project-history', 'project-picker', 'branch-picker', 'notifications', 'user-mentions', 'file-preview', 'html-preview', 'chat-performance', 'chat-stream-performance', 'settings', 'preferences', 'queued-message-behavior', 'send', 'send-handoff', 'send-rounds', 'send-queue', 'steer', 'send-guide', 'send-interrupt', 'smooth-scroll', 'composer', 'composer-glass', 'composer-video', 'markdown', 'mermaid', 'duration', 'process-counts', 'process-failed', 'agent-error', 'proposed-plan', 'changes', 'inline-diff', 'background', 'inbox', 'home', 'home-settings', 'schedules', 'home-workspace', 'home-states', 'ipad', 'licenses', 'navigation', 'model-memory', 'onboarding', 'community-notice', 'context-menu', 'chat-chrome', 'title-rename', 'composer-rich', 'composer-fullscreen'] else CHAT / ('composer.py' if case.startswith('composer-') else f'{case}.py')
                if case.startswith('send-scroll-'):
                    script = Path(__file__).with_name('send-scroll.py')
                if case in {'devices', 'devices-pad'}:
                    script = Path(__file__).with_name('devices.py')
                if case in ('diagnostics', 'directory', 'project', 'activity', 'settings-baseline', 'workspace-general', 'machine-settings', 'settings-form-backgrounds', 'prompt-shortcuts', 'project-visibility', 'github-settings', 'ai-usage', 'published-shares', 'published-share-states', 'agent-roles'):
                    script = Path(__file__).with_name(f'{case}.py')
                if case in ('archived-sessions', 'session-native', 'session-simulator', 'permission-native', 'native-diff', 'native-workspace-changes', 'native-file-content'):
                    script = Path(__file__).with_name(f'{case}.py')
                if case == 'file-selection':
                    script = Path(__file__).with_name('file-selection.py')
                if case in {'home-settings', 'home-workspace', 'ipad-create', 'morph', 'sheet-zoom-project', 'native-collection', 'ipad-chrome', 'ipad-sidebar', 'wide-panel', 'pad-layout', 'composer-relay', 'outbox', 'navigation-toolbar', 'scroll-edge', 'scroll-edge-pages', 'scroll-edge-diff', 'reply-haptics', 'free-turn-notice', 'create-parity'}:
                    script = Path(__file__).with_name(f'{case}.py')
                if case in ['session-tree', 'session-tree-pad']:
                    script = Path(__file__).with_name('session-tree.py')
                if case == 'send-handoff-delayed':
                    script = Path(__file__).with_name('send-handoff.py')
                if case in {'session-search', 'session-search-pad'}:
                    script = Path(__file__).with_name('session-search.py')
                if case == 'session-share':
                    script = Path(__file__).with_name('session-share.py')
                if case in {'session-delete', 'session-delete-pad'}:
                    script = Path(__file__).with_name('session-delete.py')
                if case.startswith('permission-mode-'):
                    script = Path(__file__).with_name('permission-mode.py')
                if case in ['fast-chat', 'fast-sheet']:
                    script = Path(__file__).with_name('fast.py')
                if case.startswith('attachment-overlay-'):
                    script = Path(__file__).with_name('attachment-selection.py' if args.photo_access == 'granted' else 'attachment-overlay.py')
                if case.startswith('attachment-motion-'):
                    script = Path(__file__).with_name('attachment-motion.py')
                if case == 'attachment-overlay-create' and args.photo_access != 'granted':
                    script = Path(__file__).with_name('attachment-create.py')
                if case.startswith('attachment-camera-') or case in ('camera-chat', 'camera-sheet'):
                    script = Path(__file__).with_name('attachment-camera.py')
                if case == 'edit-message':
                    script = Path(__file__).with_name('edit-message.py')
                if case in ['paste-plain-sheet', 'paste-plain-chat']:
                    script = Path(__file__).with_name('paste-plain.py')
                if case in ['rich-paste-sheet', 'rich-paste-chat']:
                    script = Path(__file__).with_name('rich-paste.py')
                if case == 'composer-rest-draft':
                    script = Path(__file__).with_name(f'{case}.py')
                if case == 'composer-glass-chat':
                    script = Path(__file__).with_name('composer-glass.py')
                if case == 'mentions-production':
                    script = Path(__file__).with_name('mentions-production.py')
                if case in ['role-mention-chat', 'role-mention-sheet']:
                    script = Path(__file__).with_name('role-mentions.py')
                if case in ['mention-chat', 'mention-sheet']:
                    script = Path(__file__).with_name('mentions.py')
                if case in ['camera-chat', 'camera-sheet']:
                    script = Path(__file__).with_name('attachment-camera.py')
                if case in ['send-transition', 'send-transition-handoff']:
                    script = Path(__file__).with_name('send-transition.py')
                if case == 'agents-settings':
                    script = Path(__file__).with_name('settings.py')
                command = [sys.executable, str(script), args.udid]
                if case in ['composer-success', 'composer-failure']:
                    command += ['--expect', case.removeprefix('composer-'), '--output', str(output)]
                elif case == 'layout':
                    command += ['--send']
                else:
                    command += [str(output)]
                if case.startswith('send-scroll-'):
                    command.append(case.removeprefix('send-scroll-'))
                if case == 'agents-settings':
                    command.append('--agents-only')
                check_timeout = 180
                if case == 'morph':
                    # Send, open and dismiss loops; ~175s alone with the driver's HID padding.
                    check_timeout = 300
                if case == 'native-file-content':
                    # Source, links, HTML navigation and three feedback outcomes share this case.
                    check_timeout = 300
                if case in ('agent-roles', 'published-shares', 'published-share-states'):
                    check_timeout = 420
                if case in ('settings', 'agents-settings'):
                    # These cases visit several Settings contexts or editors; settings reaches ~300s under load.
                    check_timeout = 420
                if case == 'settings-baseline':
                    # Six fixture scenarios plus page visits; ~305s under load.
                    check_timeout = 420
                if case == 'edit-message':
                    # Attachment retry, uncertain-result readback and preparation failure are separate editor visits.
                    check_timeout = 300
                if case == 'pull-request':
                    # Authorization, comment and investigation round trips share this case.
                    check_timeout = 300
                if case == 'proposed-plan':
                    # Document, search and business dispatch outcomes share this case.
                    check_timeout = 360
                if case == 'model-memory':
                    # Editing, restart or several model/agent round trips share these checks.
                    check_timeout = 420
                if case.startswith(('attachment-overlay-', 'attachment-motion-')) and args.photo_access in ['full', 'granted']:
                    check_timeout = 360
                if case == 'ipad-chrome':
                    # Each native selection probe attaches lldb; the case runs ten of them.
                    check_timeout = 360
                if case == 'ipad-sidebar':
                    # Two recorded split transitions, two rotations and three sheets share this case.
                    check_timeout = 300
                if case == 'chat-performance':
                    check_timeout = 480
                elif case in ['send-transition', 'send-transition-handoff']:
                    # Mixed-file import, text expansion, gallery gestures and
                    # per-file upload states need multiple AXe round trips.
                    # Keep each gesture/animation assertion independently bounded.
                    check_timeout = 420
                elif case == 'schedules':
                    # List/editor rollback gates and cached-detail refreshes share this case.
                    # Individual readiness assertions retain their own bounded deadlines.
                    check_timeout = 600
                elif case == 'mermaid':
                    # Six graph types, fallbacks, plan expansion and document copy.
                    check_timeout = 300
                elif case in ['file-preview', 'html-preview']:
                    # Browser/chat/process selection plus image/PDF reopen and dismissal.
                    check_timeout = 600
                elif case == 'simulator-preview':
                    # Held/cancelled/committed zoom gestures plus hide, stop and reopen flows.
                    check_timeout = 420
                elif case == 'send':
                    # Product path can finish, then AXe restore during pending
                    # toggles eats the rest of a 300s budget.
                    check_timeout = 480
                elif case == 'navigation':
                    # Three cold relaunches plus catalog links; 360s still dies on a cold CI AXe session.
                    check_timeout = 480
                elif case == 'home':
                    # Create, Debug, Settings and workspace editing share this case; ~540s alone on the native inbox.
                    check_timeout = 600
                elif case in ('session-search', 'mentions-production'):
                    # Long search and mention-kind loops reach ~290s alone.
                    check_timeout = 420
                elif case == 'session-native':
                    # Shared-feed details, PR draft handoff, previews and session actions.
                    check_timeout = 420
                elif case == 'ipad':
                    # Sidebar, both orientations, keyboard and two native creation flows.
                    check_timeout = 600
                elif case in ('wide-panel', 'pad-layout'):
                    # Both orientations and inspector/sheet preservation across width changes.
                    check_timeout = 420
                elif case == 'permission-native':
                    # Multiple fresh sessions plus nested permissions and questions can reach 300s.
                    check_timeout = 420
                elif case == 'permission':
                    check_timeout = 300
                elif case in ('send-queue', 'send-guide'):
                    # Queue/steer/stop and guide rounds reach ~185s on the native fixtures.
                    check_timeout = 300
                elif case in ('branch-picker', 'message-share', 'session-search-pad', 'chat-stream-performance', 'mention-chat', 'mention-sheet', 'preferences'):
                    check_timeout = 300
                check_started = time.monotonic()
                with (output / 'check.log').open('w') as log:
                    env = {**os.environ, 'LODY_UI_LANGUAGE': args.language}
                    env['LODY_UI_NATIVE'] = '1'
                    subprocess.run(command, check=True, timeout=check_timeout, stdout=log, stderr=subprocess.STDOUT, env=env)
                result['checkSeconds'] = round(time.monotonic() - check_started, 2)
                ui.capture('after')
                result['status'] = 'passed'
                if case in ('preferences', 'queued-message-behavior'):
                    # These checks cold-launch the App; the next case needs a fresh process baseline.
                    launch_mode = None
            except Exception as error:
                # A failed case may have crashed or left a system modal; recover explicitly.
                launch_mode = None
                result['error'] = str(error)
                try:
                    native_log = sim('spawn', args.udid, 'log', 'show', '--last', '5m', '--style', 'compact', '--predicate', 'process == "Lody"', check=False)
                    (output / 'native.log').write_text(native_log.stdout + native_log.stderr)
                except Exception as log_error:
                    result['nativeLogError'] = str(log_error)
                try:
                    ui.screenshot('failure')
                except Exception as screenshot_error:
                    result['screenshotError'] = str(screenshot_error)
                try:
                    (output / 'failure.json').write_text(ui.axe('describe-ui'))
                except Exception as capture_error:
                    result['captureError'] = str(capture_error)
                failure_png = output / 'failure.png'
                if failure_png.exists():
                    failures = args.output / 'failures'
                    failures.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(failure_png, failures / f'{appearance}-{case}.png')
            finally:
                if recording is not None:
                    recording.send_signal(signal.SIGINT)
                    try:
                        recording.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        recording.kill()
                        recording.wait()
                    recording.stderr.close()
                if require_video and recording is not None and (not (output / 'run.mp4').exists() or (output / 'run.mp4').stat().st_size == 0):
                    result['status'] = 'failed'
                    result.setdefault('error', 'Required video was not captured')
                if result['status'] == 'passed' and (output / 'motion.json').exists():
                    try:
                        assert (output / 'run-video-started').exists(), 'Motion checks need the run recording'
                        result['motionFrames'] = pad_motion.check_motion(output)
                    except Exception as motion_error:
                        result['status'] = 'failed'
                        result['error'] = f'Motion: {motion_error}'
                result['seconds'] = round(time.monotonic() - started, 2)
                results.append(result)
                (args.output / 'results.json').write_text(json.dumps(results, indent=2))
                print(json.dumps(result), flush=True)
            if fail_fast and result['status'] != 'passed':
                break
        if fail_fast and results and results[-1]['status'] != 'passed':
            break
finally:
    terminate_app()
if not results or any(r['status'] != 'passed' for r in results):
    raise SystemExit(1)
