"""Run with the native chat preview open at the bottom: python3 layout.py SIMULATOR_UDID."""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ui'))
from driver import UI
import catalog

udid = sys.argv[1]
ui = UI(udid, tempfile.mkdtemp(prefix='layout-ui-'))

def axe(*args):
    return subprocess.check_output(['axe', *args, '--udid', udid], text=True)

def rows(node):
    if isinstance(node, dict):
        if (node.get('AXUniqueId') or '').startswith('preview:') or (node.get('AXUniqueId') or '').endswith(':duration'):
            yield node
        for value in node.values():
            yield from rows(value)
    elif isinstance(node, list):
        for value in node:
            yield from rows(value)

def chat_title(items):
    return next((i for i in items if i.get('role_description') == 'Nav bar' and i.get('AXUniqueId') in ['原生聊天预览', 'Updated session title']), None)

def two_line_title(items):
    bar = chat_title(items)
    return bar if bar and bar['frame']['height'] >= 50 else None

ui.wait(two_line_title, 'Project subtitle must be visible when the chat first appears')
title = ui.element('chat-navigation-title')
spoken_title = title.get('AXLabel') or ''
assert 'lody-ios' in spoken_title, 'Navigation title must include the project name'
assert 'Studio' in spoken_title, 'Navigation title must include the computer name'
axe('tap', '--id', 'chat-navigation-title', '--post-delay', '0.3')
tree = axe('describe-ui')
assert catalog.text('session.debug.title') in tree, 'Title tap must open the debug alert'
assert 'session.id: preview' in tree, 'Debug alert must include session identifiers'
assert 'project.rootPath:' in tree, 'Debug alert must include project paths'
assert catalog.text('common.copy') in tree, 'Debug alert must offer Copy'
subprocess.run(['xcrun', 'simctl', 'pbcopy', udid], input='clipboard sentinel', text=True, check=True, timeout=10)
copy_action = next(i for i in ui.state() if i.get('AXLabel') == catalog.text('common.copy') and not i.get('AXUniqueId'))
frame = copy_action['frame']
axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.3')
copied = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', udid], text=True, timeout=10)
assert 'session.id: preview' in copied, repr(copied)
assert 'machine.name: Studio' in copied, repr(copied)
axe('tap', '--label', catalog.text('common.more'), '--element-type', 'Button', '--post-delay', '.4')
menu = axe('describe-ui')
assert catalog.text('session.action.projectFiles') in menu, 'More menu must include Project Files'
assert catalog.text('session.action.newSession') in menu
assert catalog.text('session.action.pin') in menu
assert catalog.text('session.action.archive') in menu
assert catalog.text('session.action.share') in menu, 'More menu must include Share'
axe('tap', '-x', '200', '-y', '400', '--post-delay', '.4')
axe('drag', '--start-x', '2', '--start-y', '400', '--end-x', '70', '--end-y', '400', '--duration', '1', '--post-delay', '.8')
ui.wait(two_line_title, 'Project subtitle must survive a cancelled return')
axe('tap', '--label', 'Fixtures', '--post-delay', '.3')
axe('tap', '--label', 'Session Created', '--post-delay', '1')
title = ui.element('chat-navigation-title')
assert all(text in title.get('AXLabel', '') for text in ['lody-ios', 'Studio']), 'Enabling session actions lost the two-line title'
ui.capture('created-title')
axe('tap', '--label', 'Fixtures', '--post-delay', '.3')
axe('tap', '--label', 'Rename Session', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'Updated session title' for i in items), 'Router title did not update')
for _ in range(3):
    title = ui.element('chat-navigation-title')
    assert all(text in title.get('AXLabel', '') for text in ['Updated session title', 'lody-ios', 'Studio']), 'Header refresh lost the two-line title'
    ui.wait(two_line_title, 'Project subtitle must survive a Router header refresh')
    time.sleep(.3)
ui.capture('renamed-title')
axe('tap', '--label', 'Retry')
observations = []
saw_running = False
saw_segments = False
deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    items = {item['AXUniqueId']: item for item in rows(json.loads(axe('describe-ui')))}
    saw_running |= any(catalog.text('native.chat.transcript.activity.thinking') in item.get('AXLabel', '') for item in items.values())
    saw_segments |= 'preview:middle' in items and 'preview:process:thought-two' in items
    answer = items.get('preview:answer')
    summary = items.get('preview:process')
    for item in items.values():
        if item['AXUniqueId'].startswith('preview:process'):
            observations.append({'summary': item.get('AXLabel', ''), 'summaryFrame': item['frame']})
    if answer and '分割线之后的收尾段落' in answer.get('AXLabel', ''):
        break
    time.sleep(0.15)
assert saw_running and saw_segments, 'Did not observe the live text/process segments'
assert answer and '分割线之后的收尾段落' in answer['AXLabel'], 'Conclusion did not finish'
# Rich Markdown can be taller than the viewport. Bring the completed work
# row into view before asserting its state; offscreen cells are not in AX.
thought = catalog.text('native.chat.transcript.activity.thought')
worked = catalog.text('native.chat.transcript.status.workedFor').split('{', 1)[0]
for _ in range(8):
    items = {item['AXUniqueId']: item for item in rows(json.loads(axe('describe-ui')))}
    summary = next(
        (
            item
            for item in items.values()
            if thought in item.get('AXLabel', '') and worked in item.get('AXLabel', '')
        ),
        None,
    )
    if summary:
        break
    axe('swipe', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '650', '--duration', '0.5', '--post-delay', '0.4')
else:
    raise AssertionError('Completed work row with folded process not found')
assert 'preview:intro' not in items and 'preview:middle' not in items, 'Completion must fold intermediate prose'
assert 'preview:process' not in items, 'Completion must absorb the process row into the work duration'
observations.append({'summary': summary['AXLabel'], 'summaryFrame': summary['frame']})
for item in observations:
    if worked in item.get('summary', ''):
        continue
    assert abs(item['summaryFrame']['height'] - 44) <= 1, item['summaryFrame']
assert summary['frame']['height'] < 44, (
    'The finished work row must stay copy-sized, not grow into a 44 pt slot: '
    + str(summary['frame'])
)
print(json.dumps({'samples': len(observations), 'nativeTitleAction': True,
                  'summaryHeight': summary['frame']['height'], 'streamAndCompletionObserved': True}, indent=2))

# Reaching the start loads the fixture's earlier local page before hiding its loader.
axe('tap', '-x', '100', '-y', '20', '--post-delay', '1')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'chat-history' for item in items), 'Completed local history left a loading header')
ui.capture('conversation-start')

if '--send' in sys.argv:
    # This path sends only to the local development preview, never a real session.
    assert 'Updated session title' in axe('describe-ui')
    axe('tap', '--id', 'session-input', '--post-delay', '0.5')
    ui.type_into('session-input', 'keep this message at the top.')
    time.sleep(1)
    axe('tap', '--id', 'session-send')
    time.sleep(0.7)
    def find_user(node):
        if isinstance(node, dict):
            if (node.get('AXUniqueId') or '').endswith(':user') and 'keep this message at the top.' in (node.get('AXLabel') or '').lower():
                return node
            for value in node.values():
                found = find_user(value)
                if found:
                    return found
        elif isinstance(node, list):
            for value in node:
                found = find_user(value)
                if found:
                    return found
    first = find_user(json.loads(axe('describe-ui')))
    assert first and 100 <= first['frame']['y'] <= 150, first
    time.sleep(6)
    last = find_user(json.loads(axe('describe-ui')))
    # A long answer may naturally fill the viewport and push the message up;
    # completion must never pull a short answer back down to the bottom.
    if last:
        assert last['frame']['y'] <= first['frame']['y'] + 1, last
    print('Send: new user message anchored below the native header')
