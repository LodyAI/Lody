import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])

ui.axe('tap', '--label', 'Fixtures')
ui.axe('tap', '--label', 'Process Counts Fixture', '--post-delay', '.6')


def process_row(items):
    return next(
        (
            item for item in items
            if item.get('AXUniqueId') == 'counts-preview:duration'
        ),
        None,
    )


def count_of(row):
    label = row.get('AXLabel') or ''
    return next((count for count in range(1, 10) if all(
        catalog.plural(key, count) in label
        for key in ('native.chat.transcript.activity.tools', 'native.chat.transcript.activity.editedFiles')
    )), 0)


first = ui.wait(
    lambda items: process_row(items),
    'The process counts fixture did not show a process row',
)
first_count = count_of(first)
assert 1 <= first_count < 9, first
assert ', ' in first['AXLabel'], first['AXLabel']
assert not any(item.get('AXUniqueId') == 'counts-preview:process' for item in ui.state()), (
    'The first process summary must merge into the duration row'
)
height = first['frame']['height']
assert height >= 52, 'The process row must accommodate its title and counts: ' + str(height)
ui.capture('counts-one')

changed = ui.wait(
    lambda items: next(
        (
            item for item in [process_row(items)]
            if item is not None and count_of(item) > first_count
        ),
        None,
    ),
    'Process counts did not increment',
)
assert abs(changed['frame']['height'] - height) <= 0.5, (
    'Incrementing process counts changed the row height: '
    + str((height, changed['frame']['height']))
)
ui.capture('counts-two')
for coordinate in ('x', 'y', 'width'):
    assert abs(changed['frame'][coordinate] - first['frame'][coordinate]) <= 0.5, (
        'Process count update moved the row', first['frame'], changed['frame']
    )
print('PASS: process counts increment without raising the row')
