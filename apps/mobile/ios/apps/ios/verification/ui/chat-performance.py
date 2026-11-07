"""Three repeated native scroll runs; report performance without a fake FPS gate."""
import json
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import time
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
loading_path = container / 'tmp/lody-chat-loading.json'
ui.capture('recent-messages')
ui.element('perf-9998:user')
# The initial tail remains usable while older pages are still undisplayed.
time.sleep(1)
assert not loading_path.exists(), 'History was eagerly loaded without scrolling'
existing_traces = set((container / 'tmp').glob('lody-scroll-*.json'))
def earlier_visible(items):
    return any((item.get('AXUniqueId') or '').startswith('perf-')
               and int(item['AXUniqueId'].split(':')[0].split('-')[1]) < 9950
               for item in items)

# Real finger drags must cross the boundary without a layout jump on release.
for _ in range(30):
    ui.axe('swipe', '--start-x', '200', '--start-y', '240', '--end-x', '200', '--end-y', '720', '--duration', '.25', '--post-delay', '1')
    if earlier_visible(ui.state()):
        break
else:
    raise AssertionError('Dragging to the top never exposed earlier messages')
time.sleep(1)
ui.axe('tap', '-x', '100', '-y', '20', '--post-delay', '2')
ui.capture('earlier-page')
def verify_pagination_frames():
    deadline = time.monotonic() + 5
    while not (traces := sorted(set((container / 'tmp').glob('lody-scroll-*.json')) - existing_traces)):
        assert time.monotonic() < deadline, 'Missing native pagination frame trace'
        time.sleep(.1)
    transitions = []
    for trace in traces:
        shutil.copy2(trace, ui.output / trace.name)
        samples = json.loads(trace.read_text())['samples']
        for before, after in zip(samples, samples[1:]):
            if after['count'] <= before['count'] or not before['count']:
                continue
            assert not after['dragging'] and not after['touching'] and not after['scrollingToTop'], 'History inserted during an active scroll'
            common = before['rows'].keys() & after['rows'].keys()
            assert common, 'Pagination blanked or replaced the viewport'
            drift = max(abs(after['rows'][key]['y'] - before['rows'][key]['y']) for key in common)
            transitions.append(drift)
    assert transitions and max(transitions) < 3, ('History visibly jumped between frames', transitions)
    (ui.output / 'pagination-frames.json').write_text(json.dumps({'prependCount': len(transitions), 'maxFrameDrift': max(transitions)}, indent=2))

reports = []
for run in range(3):
    existing = set((container / 'tmp').glob('lody-chat-performance-*.json'))
    ui.axe('tap', '--label', 'Run Chat Benchmark', '--post-delay', '.2')
    if run == 0:
        verify_pagination_frames()
    deadline = time.monotonic() + 330
    while not (paths := set((container / 'tmp').glob('lody-chat-performance-*.json')) - existing):
        assert time.monotonic() < deadline, 'Native benchmark did not complete'
        time.sleep(1)
    path = next(iter(paths))
    report = json.loads(path.read_text())
    shutil.copy2(path, ui.output / f'run-{run + 1}.json')
    assert report['entries'] == 10_000 and report['rows'] == 15_000, 'Incomplete dataset'
    assert 20 <= report['seconds'] < 30, 'Incomplete measurement interval'
    samples = report['samples']
    offsets = [s['offset'] for s in samples]
    assert max(offsets) - min(offsets) > 70_000, 'Scroll did not cover the requested distance'
    deltas = [b - a for a, b in zip(offsets, offsets[1:])]
    assert sum(d < -1 for d in deltas) > 20 and sum(d > 1 for d in deltas) > 20, 'Missing bidirectional motion'
    assert all(s['mib'] > 0 for s in report['memory']), 'Memory sampling failed'
    assert abs(report['fps'] - len(samples) / report['seconds']) < .001
    intervals = sorted(s['dt'] * 1000 for s in samples)
    report['p95FrameMs'] = intervals[int((len(intervals) - 1) * .95)]
    report['maxFrameMs'] = max(intervals)
    report['overBudgetPercent'] = 100 * sum(s['dt'] > s['budget'] * 1.5 for s in samples) / len(samples)
    report['visitedSectionRange'] = [min(s['firstSection'] for s in samples), max(s['lastSection'] for s in samples)]
    reports.append({k: v for k, v in report.items() if k not in ['samples', 'memory']})
    ui.capture(f'run-{run + 1}-complete')
loading = json.loads(loading_path.read_text())
shutil.copy2(loading_path, ui.output / 'loading.json')
assert loading['rows'] == 15_000, 'History is incomplete'
assert loading['firstRows'] == 75, 'First layout must contain 50 complete entries'
assert loading['anchorError'] < 3, 'Prepending history moved the reading position'
pages = loading['pages']
assert [p['rows'] for p in pages] == list(range(75, 15_001, 75)), 'Missing or duplicate history page'
assert [p['firstEntry'] for p in pages] == [f'perf-{i}' for i in range(9950, -1, -50)], 'History boundaries skipped messages'
assert len(loading['sliceMs']) > 1, 'Page preparation did not yield'
ui.axe('tap', '-x', '100', '-y', '20', '--post-delay', '2')
ui.element('perf-0:user')
assert ui.element('chat-history')['AXLabel'] == catalog.text('native.chat.history.start'), 'Missing end-of-history feedback'
ui.capture('conversation-start')
summary = {'runs': reports, 'medianFPS': statistics.median(r['fps'] for r in reports)}
(ui.output / 'performance-summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
