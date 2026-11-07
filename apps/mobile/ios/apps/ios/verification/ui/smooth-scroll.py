"""Observe real UIKit geometry alongside the runner's framebuffer recording."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
existing = set((container / 'tmp').glob('lody-scroll-*.json'))

def tap(label):
    ui.axe('tap', '--label', label, '--post-delay', '.4')

def positions():
    return {i['AXUniqueId']: i['frame']['y'] for i in ui.state()
            if (i.get('AXUniqueId') or '').startswith('scroll-cache-')}

def settled_positions():
    previous = positions()
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        time.sleep(.4)
        current = positions()
        common = previous.keys() & current.keys()
        if common and max(abs(previous[key] - current[key]) for key in common) <= .34:
            return current
        previous = current
    raise AssertionError('The injected drag did not finish decelerating')

ui.element('scroll-cache-11:text')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'scroll-cache-11:text' and '这段内容已经显示在本地' in (i.get('AXLabel') or '') for i in items), 'Cached running text did not settle')
settled_positions()
ui.capture('cache-visible')
tap('Sync History')
ui.element('scroll-new-5:text')
time.sleep(1)
ui.capture('sync-at-bottom')
assert not any(i.get('AXUniqueId') == 'chat-scroll-to-bottom' for i in ui.state()), 'Sync did not settle at the bottom'

tap('Cached History')
ui.element('scroll-cache-11:text')
settled_positions()
ui.axe('swipe', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '580', '--duration', '.8', '--post-delay', '1')
before = settled_positions()
ui.capture('reading-cache')
tap('Sync History')
time.sleep(1.5)
after = positions()
common = before.keys() & after.keys()
assert common, 'Sync lost all visible cached rows while reading'
# The first visible row anchors the viewport. Rows below the corrected row may
# legitimately move, so compare the first surviving row, not every visible row.
anchor = min(common, key=lambda key: before[key])
assert abs(before[anchor] - after[anchor]) <= 1, ('Cache update moved the reader', anchor, before, after)
ui.capture('reading-preserved')

tap('Stream Lines')
ui.element('scroll-stream:tail')
time.sleep(8)
ui.capture('stream-at-bottom')
assert not any(i.get('AXUniqueId') == 'chat-scroll-to-bottom' for i in ui.state()), 'Stream did not settle at the bottom'

tap('Stream Lines')
time.sleep(1)
ui.axe('swipe', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '600', '--duration', '.7', '--post-delay', '.7')
before = settled_positions()
time.sleep(2)
after = positions()
common = before.keys() & after.keys()
assert common, 'No history remained visible after interrupting the stream'
assert max(abs(before[key] - after[key]) for key in common) <= 1, 'Streaming pulled the reader back after a drag'
ui.capture('stream-interrupted')

tap('Stream Process')
ui.element('scroll-stream:body')
time.sleep(8)
ui.capture('process-stream')
# Dismiss the production process Sheet with a real grabber drag.
ui.axe('swipe', '--start-x', '200', '--start-y', '350', '--end-x', '200', '--end-y', '850', '--duration', '.6', '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXLabel') == 'Finish Trace' for i in items), 'Process Sheet did not dismiss')
tap('Stream Anchored Turn')
ui.element('scroll-anchor-user:duration')
time.sleep(4)
ui.capture('anchored-stream')
# A separate trace holds the list beyond its top while live updates continue.
# Real touch events let UIKit own the rubber band and its release animation.
tap('Stream Anchored Turn')
ui.element('scroll-anchor-user:duration')
time.sleep(.8)
ui.axe('drag', '--start-x', '200', '--start-y', '300', '--end-x', '200', '--end-y', '650', '--duration', '2', '--post-delay', '1')
ui.capture('top-bounce-settled')
tap('Finish Trace')
ui.element('scroll-preview')

traces = []
for path in sorted(set((container / 'tmp').glob('lody-scroll-*.json')) - existing):
    shutil.copy2(path, ui.output / path.name)
    traces.append(json.loads(path.read_text()))
assert traces, 'Missing opt-in native frame samples; rebuild the Debug app'

bounce = next((trace['samples'] for trace in traces
               if any('scroll-anchor-user:duration' in s['rows'] and s['touching'] and s['panY'] > 80
                      for s in trace['samples'])), None)
assert bounce, 'Missing real top overscroll gesture'
held = [s for s in bounce if s['touching'] and s['panY'] > 80]
assert len(held) >= 10, 'Top overscroll was not held across live updates'
assert all(s['offset'] < s['top'] - 10 for s in held), 'A live update clamped the rubber band to the top during the drag'
release = [(a, b) for a, b in zip(bounce, bounce[1:])
           if not b['touching'] and a['top'] - a['offset'] > 20 and 0 < b['t'] - a['t'] < .05]
assert release, 'Missing native release animation'
assert all(b['offset'] < b['top'] - 1 for a, b in release), 'A live update snapped the rubber band to the top on release'
assert abs(bounce[-1]['offset'] - bounce[-1]['top']) <= 1, 'The bounce did not settle at the top'

anchored = next((trace['samples'] for trace in traces
                 if any('scroll-anchor-user:duration' in s['rows'] for s in trace['samples'])
                 and not any(s['touching'] for s in trace['samples'])), None)
assert anchored, 'Missing first-turn streaming samples'
anchored = [s for s in anchored if s['t'] - anchored[0]['t'] > .3
            and 'scroll-anchor-user:duration' in s['rows']]
assert len(anchored) >= 30, 'Missing sustained anchored streaming frames'
assert max(s['contentHeight'] for s in anchored) - min(s['contentHeight'] for s in anchored) > 20, 'Reply did not grow while anchored'
anchor_drift = {}
for row in ['scroll-anchor-user:user', 'scroll-anchor-user:duration']:
    row_positions = [s['rows'][row]['y'] for s in anchored]
    drift = max(row_positions) - min(row_positions)
    anchor_drift[row] = drift
    assert drift < .1, f'{row} moved {drift}pt while the reply grew (one pixel is already a regression)'

cache = next((trace['samples'] for trace in traces if trace['host'] == 'chat'
              and any('scroll-cache-11:text' in s['rows'] for s in trace['samples'])
              and any('scroll-new-5:text' in s['rows'] and s['following'] for s in trace['samples'])), None)
assert cache, 'Missing cache-to-live transition'
start = next(i for i, sample in enumerate(cache) if sample['count'] > cache[0]['count'])
motion = [s for s in cache[start:] if s['t'] - cache[start]['t'] < 1.5]
distance = motion[0]['bottom'] - cache[start - 1]['offset']
steps = [b['offset'] - a['offset'] for a, b in zip(motion, motion[1:])]
assert distance > 300, ('Fixture did not require a substantial scroll', distance)
assert sum(step > .5 for step in steps) >= 8, 'Cache update jumped instead of traversing intermediate frames'
assert max(steps) < distance * .35, ('Cache catch-up jumped too far in one frame', max(steps), distance)
assert abs(motion[-1]['bottom'] - motion[-1]['offset']) <= 1, 'Cache animation never reached its destination'

growth = []
for trace in traces:
    samples = trace['samples']
    deltas = []
    for a, b in zip(samples, samples[1:]):
        if not a['following'] or not b['following'] or a['dragging'] or b['dragging']:
            continue
        old = a['rows'].get('scroll-stream:body')
        new = b['rows'].get('scroll-stream:body')
        if old and new and 0 < b['t'] - a['t'] < .05:
            delta = new['height'] - old['height']
            if delta > .1:
                deltas.append(delta)
    if len(deltas) >= 12:
        growth.append({'host': trace['host'], 'growingFrames': len(deltas),
                       'subLineFrames': sum(d < 12 for d in deltas), 'maxHeightStep': max(deltas)})
assert {'chat', 'process'} <= {item['host'] for item in growth}, ('Missing continuous growth in both hosts', growth)
for item in growth:
    assert item['subLineFrames'] >= item['growingFrames'] * .8, ('Height still changes by whole lines', item)
report = {'cacheDistance': distance, 'cacheMovingFrames': sum(step > .5 for step in steps),
          'cacheMaxStep': max(steps), 'readingAnchor': anchor, 'growth': growth,
          'anchoredDriftPt': anchor_drift, 'topBounceHeldFrames': len(held),
          'topBounceReleaseFrames': len(release)}
(ui.output / 'motion-summary.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
