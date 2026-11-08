"""Real native links open catalog sessions above one Home, including repeated opens and cold starts."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from driver import UI, allow_custom_scheme
import catalog

udid = sys.argv[1]
ui = UI(udid, sys.argv[2])


def stack(expected):
    wants_session = len(expected) > 1
    def matches(items):
        session = any(i.get('AXUniqueId') == 'session-input' for i in items)
        return session == wants_session
    ui.wait(matches, f'Expected native {"session" if wants_session else "home"} above one shell root')


def swipe_back():
    # Explicit touch moves reach UIKit's interactive pop on iOS 27.
    ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '365',
           '--end-y', '450', '--duration', '.5', '--post-delay', '1')


_scheme_allowed = False


def open_url(path):
    global _scheme_allowed
    subprocess.run(['xcrun', 'simctl', 'openurl', udid, f'lody:///{path}'], check=True, timeout=30)
    # First use of the custom scheme shows a SpringBoard confirmation. describe-ui
    # hangs on that alert, so tap Open without reading the tree. Later links must
    # not spend 8s per missing label or tap through the home catalog.
    if _scheme_allowed:
        time.sleep(0.5)
        return
    allow_custom_scheme(ui)
    _scheme_allowed = True


def session(title):
    stack(['index', 'presented/[presentationId]'])
    ui.element('session-input')
    ui.wait(lambda items: any(title in (i.get('AXLabel') or '') for i in items), f'Missing session title {title}')


embedded = bool(os.environ.get('LODY_UI_NATIVE'))
_root_swiped = False


def home(name):
    stack(['index'])
    label = catalog.workspace_switch('我的超长工作区名称不能折行')
    button = ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == label and i.get('type') == 'Button'), None), 'Workspace button disappeared')
    frame = button['frame']
    assert frame['width'] > 200 and frame['height'] >= 44, frame
    settings = next(i['frame'] for i in ui.state() if i.get('AXLabel') == catalog.text('inbox.settings.section.view') and i.get('type') == 'Button')
    assert frame['x'] + frame['width'] <= settings['x'], 'Workspace overlaps navigation actions'
    time.sleep(.5)
    settled = next(i['frame'] for i in ui.state() if i.get('AXLabel') == label and i.get('type') == 'Button')
    assert all(abs(frame[key] - settled[key]) < 1 for key in ('x', 'y', 'width', 'height')), 'Workspace button moved after settling'
    assert not any(i.get('AXUniqueId') == 'BackButton' for i in ui.state()), 'Home has a back button'
    global _root_swiped
    if not embedded or not _root_swiped:
        swipe_back()
        stack(['index'])
        _root_swiped = True
    ui.capture(name)


home('initial-home')
# Recreate the process with the same offline launch contract to cover startup
# ordering between native header configuration and the workspace props.
for index in range(2 if embedded else 3):
    subprocess.run(['xcrun', 'simctl', 'terminate', udid, 'ai.lody.mobile'], check=True, timeout=30)
    ui.invalidate_axe()
    launch = ['xcrun', 'simctl', 'launch', udid, 'ai.lody.mobile', '--ui-verify', '--ui-verify-home',
              '-AppleLanguages', f'({catalog.LANGUAGE})',
              '-AppleLocale', 'en_US' if catalog.LANGUAGE == 'en' else 'zh_CN']
    subprocess.run(launch, check=True, timeout=30)
    ui.element('ui-verify-ready', timeout=90)
    home(f'cold-home-{index}')
# Exercise the production row push, then cancel an edge pop before completing
# it. The recording also covers toolbar retirement during the push itself.
# Separate HID down/up events can become a long press on a busy CI Simulator.
ui.axe('tap', '--label', '首页交互设计', '--tap-style', 'simulator', '--post-delay', '.6')
session('首页交互设计')
search_label = catalog.text('search.field.placeholder')


def no_home_search():
    assert not any((i.get('AXValue') == search_label or (i.get('AXLabel') == search_label and i.get('type') == 'Button')) for i in ui.state()), 'Home search leaked over the session'


no_home_search()
ui.capture('toolbar-pushed')

def conversation_header_geometry():
    back = ui.element('BackButton')['frame']
    title = ui.element('chat-navigation-title')['frame']
    assert back['width'] >= 44 and back['height'] >= 44, back
    return (title['x'] - back['x'], title['y'] - back['y'], title['width'], back['width'])

def held_pop():
    container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', udid, 'ai.lody.mobile', 'data'], text=True).strip())
    signal = container / 'tmp/lody-header-mid.json'
    evidence = container / 'tmp/lody-header-transition.json'
    signal.unlink(missing_ok=True)
    evidence.unlink(missing_ok=True)
    # Non-back drags must not even start a navigation transition.
    for start, end in [((200, 600), (200, 350)), ((300, 450), (80, 450))]:
        ui.axe('drag', '--start-x', str(start[0]), '--start-y', str(start[1]),
               '--end-x', str(end[0]), '--end-y', str(end[1]), '--duration', '.5', '--post-delay', '.6')
        assert not evidence.exists(), 'A non-back drag started a pop'
    process = subprocess.Popen(['axe', 'drag', '--udid', udid, '--start-x', '2', '--start-y', '450',
                                '--end-x', '160', '--end-y', '450', '--duration', '8', '--steps', '4'])
    try:
        deadline = time.monotonic() + 25
        while not signal.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.05)
        assert signal.exists(), 'No held interactive transition was observed'
        subprocess.run(['xcrun', 'simctl', 'io', udid, 'screenshot', str(ui.output / 'header-held.png')], check=True, timeout=10)
        assert process.wait(timeout=25) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    deadline = time.monotonic() + 5
    while not evidence.exists() and time.monotonic() < deadline:
        time.sleep(.05)
    result = json.loads(evidence.read_text())
    (ui.output / 'header-transition.json').write_text(json.dumps(result))
    assert result['cancelled'], 'Short held drag must cancel'
    samples = [row for row in result['samples'] if .1 < row[0] < .8]
    assert samples and max(row[1] for row in samples) > 20, 'Page never moved'
    for column in (3, 5, 7):
        assert max(row[column] for row in samples) - min(row[column] for row in samples) < 1, ('Header moved relative to page', column)
    assert max(row[2] for row in samples) - min(row[2] for row in samples) > 20, 'Back remained screen-owned'

header_before_cancel = conversation_header_geometry()
held_pop()
session('首页交互设计')
no_home_search()
ui.capture('toolbar-pop-cancelled')
header_after_cancel = conversation_header_geometry()
assert all(abs(before - after) < 1 for before, after in zip(header_before_cancel, header_after_cancel)), (
    'Cancelled pop changed relative back/title geometry', header_before_cancel, header_after_cancel)
# A second cancellation must not accumulate offsets.
ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '65',
       '--end-y', '450', '--duration', '1', '--post-delay', '.6')
session('首页交互设计')
assert all(abs(before - after) < 1 for before, after in zip(header_before_cancel, conversation_header_geometry()))

# A deeper native file page must keep its own bar and return to the page-owned header.
open_url('debug?verifyCase=home-file-preview')
file_row = 'diff-preview:changes:docs/superpowers/.diff-check.md'
ui.element(file_row)
ui.axe('tap', '--id', file_row, '--post-delay', '.6')
ui.element('diff-toolbar-stats')
ui.element('BackButton')
ui.capture('native-detail')
swipe_back()
ui.element(file_row)
# Portrait detail roots are native sheets; dismiss the sheet, not its root stack.
ui.axe('drag', '--start-x', '200', '--start-y', '100', '--end-x', '200',
       '--end-y', '820', '--duration', '.5', '--post-delay', '1')
ui.wait(lambda items: not any(i.get('AXUniqueId') == file_row for i in items), 'Detail sheet did not dismiss')
session('首页交互设计')
assert all(abs(before - after) < 1 for before, after in zip(header_before_cancel, conversation_header_geometry()))
ui.capture('detail-returned')

swipe_back()
home('toolbar-returned')
ui.wait(lambda items: any((i.get('AXValue') == search_label or (i.get('AXLabel') == search_label and i.get('type') == 'Button')) for i in items), 'Home search did not return')

for index in range(1 if embedded else 2):
    open_url('ui-home/sessions/ui-design')
    session('首页交互设计')
    ui.capture(f'linked-session-{index}')
    ui.axe('drag', '--start-x', '80', '--start-y', '450', '--end-x', '385',
           '--end-y', '450', '--duration', '.5', '--post-delay', '1')
    home(f'returned-{index}')

# A fresh link while a session is already open replaces the external path above Home.
open_url('ui-home/sessions/ui-design')
session('首页交互设计')
open_url('ui-home/sessions/ui-chat')
session('纯对话草稿')
ui.capture('relinked-session')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '1')
home('relinked-return')

print('PASS: warm, cold, toolbar and relinked session links return to one Home.')

# Exercise the real page-owned header over a long transcript without fixture controls.
open_url('debug?verifyCase=send-header-preview')
ui.element('session-input')
ui.wait(lambda items: any('The first check is an ordinary new turn' in (i.get('AXLabel') or '') for i in items), 'Header fixture transcript did not load')
header = ui.element('chat-navigation-title')['frame']
transcript = ui.element('chat-transcript')['frame']
assert transcript['y'] < header['y'] + header['height'], 'Transcript no longer underlaps the header'
assert not any(i.get('AXUniqueId') == 'send-connect' for i in ui.state()), 'Debug controls obscure the header'
ui.capture('transparent-header-resting')
ui.axe('drag', '--start-x', '200', '--start-y', '320', '--end-x', '200',
       '--end-y', '570', '--duration', '1', '--post-delay', '1')
ui.element('chat-scroll-to-bottom')
after = ui.element('chat-navigation-title')['frame']
assert all(abs(header[key] - after[key]) < 1 for key in ('x', 'y', 'width', 'height')), 'Scrolling moved the header'
ui.capture('transparent-header-underlap')
print('PASS: transparent header stays fixed over scrolled content; inspect the native soft edge visually.')
