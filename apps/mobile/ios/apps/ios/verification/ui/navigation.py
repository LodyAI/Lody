"""Real native links open catalog sessions above one Home, including repeated opens and cold starts."""
import json
import os
import subprocess
import sys
import time
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
    settings = next(i['frame'] for i in ui.state() if i.get('AXLabel') == catalog.text('tabs.settings') and i.get('type') == 'Button')
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
ui.axe('tap', '--id', 'ui-design', '--tap-style', 'simulator', '--post-delay', '.6')
session('首页交互设计')
search_label = catalog.text('search.field.placeholder')


def no_home_search():
    assert not any(i.get('AXValue') == search_label for i in ui.state()), 'Home search leaked over the session'


no_home_search()
ui.capture('toolbar-pushed')
ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '65',
       '--end-y', '450', '--duration', '1', '--post-delay', '.6')
session('首页交互设计')
no_home_search()
ui.capture('toolbar-pop-cancelled')
swipe_back()
home('toolbar-returned')
ui.wait(lambda items: any(i.get('AXValue') == search_label for i in items), 'Home search did not return')

for index in range(1 if embedded else 2):
    open_url('ui-home/sessions/ui-design')
    session('首页交互设计')
    ui.capture(f'linked-session-{index}')
    swipe_back()
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
