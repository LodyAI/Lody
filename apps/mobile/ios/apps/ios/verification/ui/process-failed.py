import sys
import time
from driver import UI
import catalog

ui = UI(*sys.argv[1:])

ui.axe('tap', '--label', 'Fixtures', '--post-delay', '.5')
labels = [item.get('AXLabel') or '' for item in ui.state()]
if 'Failed Tool Fixture' not in labels:
    raise AssertionError('Fixtures menu did not include Failed Tool Fixture: ' + repr([label for label in labels if label]))
ui.axe('tap', '--label', 'Failed Tool Fixture', '--post-delay', '.6')

thinking = catalog.text('native.chat.transcript.activity.thinking')
read = catalog.plural('native.chat.transcript.activity.readFiles', 1)
tools = catalog.plural('native.chat.transcript.activity.tools', 1)


def process_row(items):
    return next(
        (
            item for item in items
            if item.get('AXUniqueId') == 'failed-preview:duration'
            and thinking in (item.get('AXLabel') or '')
        ),
        None,
    )


row = ui.wait(
    lambda items: process_row(items),
    'The failed-tool fixture did not show a live thinking process row',
)
label = row.get('AXLabel') or ''
assert thinking in label, label
assert read in label, label
assert tools in label, label
assert ', ' in label, label
assert not any(item.get('AXUniqueId') == 'failed-preview:process' for item in ui.state()), (
    'The failed-tool summary must merge into the duration row'
)
assert row['frame']['height'] >= 52, (
    'The failed-tool process row must accommodate its title and summary: ' + str(row['frame'])
)
ui.capture('failed-live')
time.sleep(2.2)
still = ui.element('failed-preview:duration')
assert thinking in (still.get('AXLabel') or ''), still.get('AXLabel')
assert abs(still['frame']['height'] - row['frame']['height']) <= 0.5, still['frame']
ui.capture('failed-shine')

ui.axe('tap', '--id', 'failed-preview:duration', '--post-delay', '.7')
running = ui.element('failed-preview:read')
assert '继续读取' in (running.get('AXLabel') or ''), running.get('AXLabel')
ui.capture('process-detail-shine-start')
time.sleep(.35)
still_running = ui.element('failed-preview:read')
assert '继续读取' in (still_running.get('AXLabel') or ''), still_running.get('AXLabel')
ui.capture('process-detail-shine-end')
print('PASS: live process details use traveling text shine without a trailing spinner')
