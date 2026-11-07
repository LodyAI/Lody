"""Show pinning versus guidance against several screens of real chat content."""
import json
import sys
from driver import UI
from send_motion import ThrowTrace

ui = UI(sys.argv[1], sys.argv[2])
mode = sys.argv[3]
trace = ThrowTrace(ui)
ui.axe('tap', '--id', 'send-connect')
ui.element('running-reply:text')
ui.capture('context-at-tail')
viewport = ui.element('chat-transcript')['frame']
ui.axe('swipe', '--start-x', '180', '--start-y', str(viewport['y'] + 100),
       '--end-x', '180', '--end-y', str(viewport['y'] + 360), '--duration', '.5', '--post-delay', '.6')
ui.capture('earlier-context')
ui.axe('tap', '--id', 'chat-scroll-to-bottom', '--post-delay', '.6')

ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', 'Keep the existing draft when the connection fails.')
ui.axe('tap', '-x', '5', '-y', str(viewport['y'] + 10), '--post-delay', '.6')
# Resume following after dismissing the keyboard through the transcript margin.
ui.axe('swipe', '--start-x', '180', '--start-y', str(viewport['y'] + 180),
       '--end-x', '180', '--end-y', str(viewport['y'] + 120), '--duration', '.3', '--post-delay', '.6')
ui.capture('before-send')
ui.axe('tap', '--id', 'session-send')
ui.wait(lambda items: any(i.get('AXLabel') == 'Calls: 1 · sending' for i in items), 'Send did not start')
if mode == 'queue':
    ui.axe('tap', '--id', 'send-complete')
    queued = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':steer') and i.get('enabled')), None), 'Queued message did not become steerable')
    turn = queued['AXUniqueId'].removesuffix(':steer')
    ui.capture('before-steer')
    ui.axe('tap', '--id', queued['AXUniqueId'])
else:
    row = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':user') and not i['AXUniqueId'].startswith('send-context-')), None), 'Sent message missing')
    turn = row['AXUniqueId'].removesuffix(':user')

bubble = ui.element(turn + ':user')['frame']
field = ui.element('session-input')['frame']
available = field['y'] - viewport['y']
gap = field['y'] - bubble['y'] - bubble['height']
ui.wait(lambda _: trace.reserved_space() is not None, 'Native landing geometry missing')
reserved = trace.reserved_space()
if mode == 'normal':
    assert bubble['y'] <= viewport['y'] + 24, 'Ordinary send did not land at the top'
    assert gap > available * .4 and reserved > 100, 'Ordinary send did not reserve reply space'
else:
    assert bubble['y'] > viewport['y'] + available * .45, 'Guidance was pushed toward the top'
    assert 0 <= gap < 80 and abs(reserved) < 1, 'Guidance left an empty viewport below its message'
    ui.element('running-reply:text')
ui.capture('after-send')
ui.axe('tap', '--id', 'send-complete', '--post-delay', '.6')
if mode != 'normal':
    request = json.loads(ui.element('control-request')['AXLabel'])
    assert request['action'] == 'steer' and request['messageId'] == turn
ui.element(turn + ':user')
ui.capture('after-history')
trace.verify(1)
traces = [json.loads(path.read_text()) for path in (set(trace.folder.glob('lody-throw-*.json')) - trace.existing)]
samples = [s for t in traces for s in t['samples'] if 'listFrame' in s]
assert samples and max(s['contentHeight'] / s['listFrame'][3] for s in samples) > 2, 'Context did not exceed two full viewports'
(ui.output / 'scroll-result.json').write_text(json.dumps({
    'mode': mode, 'messageTop': bubble['y'], 'viewportTop': viewport['y'],
    'visibleHeight': available, 'gapBelowMessage': gap, 'reservedSpace': reserved,
    'contextViewportCount': max(s['contentHeight'] / s['listFrame'][3] for s in samples),
}, indent=2) + '\n')
print('PASS: long-context ' + mode + ' send has the expected message position and reply space')
