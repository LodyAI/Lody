"""A user-message context menu lifts one clear bubble and copies its full text."""
import subprocess
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])

ui.axe('tap', '--label', 'Fixtures')
ui.axe('tap', '--label', 'Diff Fixture', '--post-delay', '.8')
message = ui.element('diff-user:user')
expected = message['AXLabel']
frame = message['frame']
old_copy_frames = {
    tuple(item['frame'][key] for key in ('x', 'y', 'width', 'height'))
    for item in ui.state()
    if (item.get('AXLabel') or '').casefold() == catalog.system('copy').casefold()
    and item.get('frame')
}

subprocess.run(
    ['xcrun', 'simctl', 'pbcopy', ui.udid],
    input='context menu sentinel',
    text=True,
    check=True,
    timeout=10,
)
ui.axe(
    'touch',
    '-x', str(frame['x'] + frame['width'] / 2),
    '-y', str(frame['y'] + frame['height'] / 2),
    '--down', '--up', '--delay', '.8',
)
copy = ui.wait(
    lambda items: next(
        (
            item for item in items
            if (item.get('AXLabel') or '').casefold() == catalog.system('copy').casefold()
            and item.get('frame')
            and tuple(item['frame'][key] for key in ('x', 'y', 'width', 'height')) not in old_copy_frames
        ),
        None,
    ),
    'Long press did not open the user-message context menu',
)
ui.capture('context-menu')
copy_frame = copy['frame']
ui.axe(
    'tap',
    '-x', str(copy_frame['x'] + copy_frame['width'] / 2),
    '-y', str(copy_frame['y'] + copy_frame['height'] / 2),
    '--post-delay', '.4',
)
copied = subprocess.check_output(
    ['xcrun', 'simctl', 'pbpaste', ui.udid],
    text=True,
    timeout=10,
)
assert copied == expected, repr(copied)
print('PASS: user-message context menu opens from a physical long press and copies the full text')
