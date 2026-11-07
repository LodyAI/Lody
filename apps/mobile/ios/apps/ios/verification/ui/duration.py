"""Turn and process-segment durations freeze independently at their boundaries."""
import sys
import time
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
copy = {
    'en': {
        'working': 'Processing for ',
        'worked': 'Processed for ',
        'finished': ('Processed for 1m 04s', 'Processed for 1m 05s', 'Processed for 1m 06s'),
        'waited': ('Processed for 59s', 'Processed for 1m 00s', 'Processed for 1m 01s'),
    },
    'zh-Hans': {
        'working': '已处理 ',
        'worked': '处理了 ',
        'finished': ('处理了 1分 04秒', '处理了 1分 05秒', '处理了 1分 06秒'),
        'waited': ('处理了 59秒', '处理了 1分 00秒', '处理了 1分 01秒'),
    },
}[catalog.LANGUAGE]

ui.axe('tap', '--label', 'Fixtures')
ui.axe('tap', '--label', 'Duration Fixture', '--post-delay', '.5')


def duration_row(items, prefix):
    return next(
        (
            item for item in items
            if item.get('AXUniqueId') == 'duration-preview:duration'
            and (item.get('AXLabel') or '').startswith(prefix)
        ),
        None,
    )


live = ui.wait(
    lambda items: duration_row(items, copy['working']),
    'The live assistant row did not show its work duration',
)
first_label = live['AXLabel']
advanced = ui.wait(
    lambda items: next(
        (
            item for item in [duration_row(items, copy['working'])]
            if item is not None and item.get('AXLabel') != first_label
        ),
        None,
    ),
    'The live assistant work duration did not advance',
)
assert advanced['AXLabel'].startswith(copy['working'])
assert not any(
    child.get('AXValue') == '1' for child in advanced.get('children', [])
), 'The duration row still exposes a loading indicator'
assert ', ' in advanced['AXLabel'], advanced['AXLabel']
assert advanced['AXLabel'].partition(', ')[2], advanced['AXLabel']
assert advanced['frame']['height'] >= 52, advanced['frame']
assert not any(item.get('AXUniqueId') == 'duration-preview:process' for item in ui.state()), (
    'The first live process summary must merge into the duration row'
)
ui.capture('working')
assert not any((item.get('AXUniqueId') or '').startswith('duration-preview:meta') for item in ui.state()), 'Live replies must not show metadata actions'

ui.axe('tap', '--label', 'Continue Duration Fixture', '--post-delay', '.5')
segment = ui.wait(
    lambda items: next((item for item in [duration_row(items, copy['working'])]
        if item is not None
        and catalog.plural('native.chat.transcript.activity.readFiles', 1) in item['AXLabel']
        and catalog.text('native.chat.transcript.activity.thinking') not in item['AXLabel']), None),
    'The earlier process segment still shows processing while the reply continues',
)
assert catalog.text('native.chat.transcript.activity.thinking') not in segment['AXLabel'], segment['AXLabel']
assert catalog.plural('native.chat.transcript.activity.readFiles', 1) in segment['AXLabel'], segment['AXLabel']
next_process = ui.element('duration-preview:process:next-thought')
assert catalog.text('native.chat.transcript.activity.thinking') in next_process['AXLabel'], next_process['AXLabel']
assert next_process['frame']['y'] > segment['frame']['y'], (segment, next_process)
assert duration_row(ui.state(), copy['working']), 'A finished segment must not finish the whole turn'
assert not any(item.get('AXUniqueId') == 'duration-preview:process' for item in ui.state()), (
    'The completed first segment must remain merged while the turn continues'
)
segment_label = segment['AXLabel'].partition(', ')[2]
assert segment_label, segment['AXLabel']
time.sleep(1.2)
assert ui.element('duration-preview:duration')['AXLabel'].partition(', ')[2] == segment_label
ui.capture('segment-finished')
ui.axe('tap', '--id', 'duration-preview:duration', '--post-delay', '.6')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'duration-preview:thought' for item in items),
        'The completed segment no longer opens its process details')
assert not any(item.get('AXUniqueId') == 'duration-preview:next-thought' for item in ui.state()), 'The first segment opened the later process'
ui.capture('segment-details')
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=catalog.text('process.title')), '--post-delay', '.6')

ui.axe('tap', '--label', 'Finish Duration Fixture', '--post-delay', '.5')
finished = ui.wait(
    lambda items: duration_row(items, copy['worked']),
    'The completed assistant row did not show its frozen work duration',
)
assert finished['AXLabel'].partition(', ')[0] in copy['finished'], finished['AXLabel']
assert finished['AXLabel'].partition(', ')[2], finished['AXLabel']
assert catalog.text('native.chat.transcript.activity.thought') not in finished['AXLabel'], finished['AXLabel']
assert catalog.plural('native.chat.transcript.activity.readFiles', 1) in finished['AXLabel'], finished['AXLabel']
assert finished['frame']['height'] >= 52, (
    'A finished process row must accommodate its title and summary: '
    + str((advanced['frame'], finished['frame']))
)
finished_label = finished['AXLabel']
time.sleep(1.2)
assert ui.element('duration-preview:duration')['AXLabel'] == finished_label

answer = ui.element('duration-preview:answer')
assert not any(item.get('AXUniqueId') == 'duration-preview:process' for item in ui.state()), (
    'Completion must absorb the process row into the work duration'
)
assert answer['frame']['y'] >= finished['frame']['y'] + finished['frame']['height'] - 1
assert answer['frame']['height'] >= 36, (
    'Body copy under the process rail row must keep a paragraph inset: '
    + str(answer['frame'])
)
model = ui.element('duration-preview:meta:details')
assert 'GPT-5.6 Sol · High · ' in model['AXLabel'], model['AXLabel']
assert '\ufffc' not in model['AXLabel'], 'The provider mark must stay decorative'
assert ':' in model['AXLabel'].rsplit(' · ', 1)[1], 'A same-day reply ends with a clock time'
assert model['frame']['y'] >= answer['frame']['y'] + answer['frame']['height'] - 1
assert abs(model['frame']['x'] - answer['frame']['x']) <= 1, (model['frame'], answer['frame'])
ui.capture('finished')

ui.axe('tap', '--label', 'Wait Duration Fixture', '--post-delay', '.5')
waited = ui.wait(
    lambda items: next(
        (
            item for item in [duration_row(items, copy['worked'])]
            if item is not None
            and any(token in (item.get('AXLabel') or '') for token in copy['waited'])
        ),
        None,
    ),
    'Subtracting permissionWaitMs did not freeze the OSS duration',
)
time.sleep(1.2)
assert ui.element('duration-preview:duration')['AXLabel'] == waited['AXLabel']
ui.capture('waited')
print('PASS: duration freezes and the metadata bar reads left-aligned under the answer')
print('PASS: permission wait is subtracted from the frozen work duration')

ui.axe('tap', '--label', 'Fixtures')
ui.axe('tap', '--label', 'Causal Reply Fixture')

def causal_rows(seconds):
    ui.element('causal-a1:text')
    ui.element('causal-a2:text')
    ui.wait(lambda items: any(item.get('AXUniqueId') == 'causal-u2:duration'
            and item.get('AXLabel') == f"{copy['worked']}{seconds}s" for item in items),
            'The second reply borrowed the first request clock or disappeared')
    assert ui.element('causal-u1:duration')['AXLabel'] == f"{copy['worked']}3s"
    assert not any(item.get('AXLabel') == catalog.text('native.chat.error.transcript') for item in ui.state())

causal_rows(3)
ui.capture('causal-orphan')
ui.axe('tap', '--label', 'Receive Late Input')
ui.element('causal-u2:user')
causal_rows(4)
ui.capture('causal-late-input')
ui.axe('tap', '--label', 'Order Causal Input')
causal_rows(4)
assert ui.element('causal-u2:user')['frame']['y'] < ui.element('causal-a2:text')['frame']['y']
ui.capture('causal-ordered')
print('PASS: both replies remain readable through orphan, late input and causal reordering')
