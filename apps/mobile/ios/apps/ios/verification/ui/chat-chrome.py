"""Composer chip row, live subtask details, and native connection/scroll chrome."""
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])


def center_x(frame):
    return frame['x'] + frame['width'] / 2


def mid_y(frame):
    return frame['y'] + frame['height'] / 2


def max_y(frame):
    return frame['y'] + frame['height']


def chrome_center():
    transcript = ui.element('chat-transcript')
    return center_x(transcript['frame'])


def overlay(name):
    ui.axe('tap', '--label', 'Overlays')
    ui.wait(lambda items: any(i.get('AXLabel') == name for i in items), 'Overlays submenu never opened')
    ui.axe('tap', '--label', name, '--post-delay', '.5')


ui.axe('tap', '--label', 'Fixtures')
overlay('Connecting Overlay')
status = ui.element('chat-overlay-status')
assert status.get('AXLabel') == catalog.text('native.chat.connection.connecting')
assert 'chat-scroll-to-bottom' not in ui.axe('describe-ui'), 'Connecting at the tail must not show scroll-to-bottom'
assert abs(center_x(status['frame']) - chrome_center()) <= 1, 'Connecting alone is not on the composer center'
assert 28 <= status['frame']['height'] <= 34, 'Status should fit one line with compact padding'
ui.capture('connecting')

ui.axe('drag', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '700', '--duration', '1', '--post-delay', '1')
status = ui.element('chat-overlay-status')
scroll = ui.element('chat-scroll-to-bottom')
assert abs(center_x(status['frame']) - chrome_center()) <= 1, 'Showing scroll moved the connection status'
assert abs(max_y(status['frame']) - max_y(scroll['frame'])) <= 1, 'Paired glasses do not share a baseline'
assert abs(scroll['frame']['width'] - 30) <= 1
assert abs(scroll['frame']['height'] - 30) <= 1
ui.capture('connecting-and-scroll')

ui.axe('tap', '--label', 'Fixtures')
overlay('Paused Overlay')
paused = ui.element('chat-overlay-status')
assert paused.get('AXLabel') == catalog.text('native.chat.connection.paused')
ui.element('chat-scroll-to-bottom')
ui.capture('paused-and-scroll')

ui.axe('tap', '-x', str(center_x(scroll['frame']) + 21), '-y', str(mid_y(scroll['frame'])), '--post-delay', '1.2')
paused = ui.element('chat-overlay-status')
assert 'chat-scroll-to-bottom' not in ui.axe('describe-ui'), 'Returning to the tail must drop scroll-to-bottom'
assert abs(center_x(paused['frame']) - chrome_center()) <= 1, 'Paused alone did not return to center'
ui.capture('paused')

ui.axe('tap', '--label', 'Fixtures')
overlay('Clear Overlay')
assert 'chat-overlay-status' not in ui.axe('describe-ui'), 'Clearing overlay must remove the status glass'
ui.axe('drag', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '700', '--duration', '1', '--post-delay', '1')
scroll_only = ui.element('chat-scroll-to-bottom')['frame']
assert abs(scroll_only['x'] - scroll['frame']['x']) <= 1, 'Hiding status moved the scroll action'
ui.capture('scroll-only')
ui.axe('tap', '--label', 'Fixtures')
overlay('Tasks Overlay')
tasks = ui.element('session-subtasks')
assert tasks.get('AXLabel') == catalog.plural('native.chat.overlay.tasks', 1), tasks.get('AXLabel')
assert 'chat-overlay-status' not in ui.axe('describe-ui'), 'Task count must leave the floating overlay'
assert abs(tasks['frame']['x'] - 20) <= 1, 'Tasks must start on the composer chip row'
assert max_y(tasks['frame']) <= ui.element('session-input')['frame']['y'], 'Tasks overlap the input'
ui.capture('tasks')
cards = {item: ui.element('task-reply:' + item) for item in ('explore', 'tests', 'review')}
assert 'task-reply:house' not in ui.axe('describe-ui'), 'Housekeeping tasks must stay off the transcript'
assert catalog.text('native.chat.subagent.completed') in (cards['tests'].get('AXValue') or ''), cards['tests'].get('AXValue')
assert catalog.text('native.chat.subagent.failed') in (cards['review'].get('AXValue') or ''), cards['review'].get('AXValue')
assert cards['explore']['frame']['y'] < cards['tests']['frame']['y'] < cards['review']['frame']['y'], 'Task cards left item order'
ui.capture('task-cards')
ui.axe('tap', '--id', 'task-reply:tests', '--post-delay', '1')
result = ui.element('subagent-detail-result')
assert (result.get('AXLabel') or '').startswith('All 12 cases pass'), result.get('AXLabel')
ui.element('subagent-detail-copy')
ui.capture('task-detail')
detail_grabber = next(i['frame'] for i in ui.state() if i.get('AXLabel') == 'Sheet Grabber')
ui.axe(
    'drag',
    '--start-x', str(detail_grabber['x'] + detail_grabber['width'] / 2),
    '--start-y', str(detail_grabber['y'] + detail_grabber['height'] / 2),
    '--end-x', str(detail_grabber['x'] + detail_grabber['width'] / 2),
    '--end-y', '900',
    '--duration', '0.4',
    '--post-delay', '.8',
)
ui.wait(
    lambda items: not any(i.get('AXUniqueId') == 'subagent-detail-result' for i in items),
    'Subtask detail did not dismiss',
)
ui.axe('tap', '--id', 'session-subtasks', '--post-delay', '.8')
ui.wait(
    lambda items: any(i.get('AXLabel') == catalog.text('process.tasks') for i in items),
    'Task overlay did not open the subtask sheet',
)
ui.capture('tasks-sheet')
grabber = next(i['frame'] for i in ui.state() if i.get('AXLabel') == 'Sheet Grabber')
ui.axe(
    'drag',
    '--start-x', str(grabber['x'] + grabber['width'] / 2),
    '--start-y', str(grabber['y'] + grabber['height'] / 2),
    '--end-x', str(grabber['x'] + grabber['width'] / 2),
    '--end-y', '900',
    '--duration', '0.4',
    '--post-delay', '.8',
)
ui.wait(
    lambda items: any(i.get('AXUniqueId') == 'session-subtasks' for i in items),
    'Dismissing the subtask sheet hid the overlay',
)
ui.axe('tap', '--id', 'task-reply:explore', '--post-delay', '.5')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'task-reply:explore-thought' for i in items), 'Missing subtask thinking')
assert 'Trace the shared composer' in ui.element('task-reply:explore-thought').get('AXLabel', '')
ui.element('task-reply:explore-read')
ui.capture('subtask-process')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'task-reply:explore-answer' for i in items), 'Open subtask did not update with its parent source')
ui.capture('subtask-process-updated')
ui.axe('tap', '--id', 'task-reply:explore-read', '--post-delay', '.5')
ui.wait(lambda items: any('cat ChatComposerView.swift' in (i.get('AXLabel') or '') for i in items), 'Nested tool detail did not open')
ui.capture('subtask-tool-detail')
# Close the nested detail and its owning subtask sheet independently.
for _ in range(2):
    grabber = max((i['frame'] for i in ui.state() if i.get('AXLabel') == 'Sheet Grabber'), key=lambda frame: frame['y'])
    ui.axe('drag', '--start-x', str(center_x(grabber)), '--start-y', str(mid_y(grabber)), '--end-x', str(center_x(grabber)), '--end-y', '900', '--duration', '.4', '--post-delay', '.8')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'session-subtasks' for i in items), 'Completed task count remained in the composer')
ui.axe('tap', '--label', 'Fixtures')
overlay('Clear Overlay')
ui.axe('drag', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '700', '--duration', '1', '--post-delay', '1')
ui.axe('tap', '--label', 'Fixtures')
overlay('Connecting Overlay')
ui.axe('tap', '--id', 'session-input', '--post-delay', '1')
ui.wait(lambda items: any((i.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar') for i in items),
        'Software keyboard did not appear')
status_keyboard = ui.element('chat-overlay-status')['frame']
scroll_keyboard = ui.element('chat-scroll-to-bottom')['frame']
input_frame = ui.element('session-input')['frame']
assert status_keyboard['y'] < status['frame']['y'] - 100, 'Chrome did not follow the raised composer'
assert abs(max_y(status_keyboard) - max_y(scroll_keyboard)) <= 1, 'Keyboard separated the chrome baseline'
assert abs(scroll_keyboard['x'] - scroll['frame']['x']) <= 1, 'Keyboard moved the trailing scroll action horizontally'
assert scroll_keyboard['y'] + scroll_keyboard['height'] < input_frame['y'], 'Scroll action overlaps the input'
ui.capture('keyboard')
print('PASS: native composer task chip, live subtask history and tool details, independent connection status, and keyboard clearance')
