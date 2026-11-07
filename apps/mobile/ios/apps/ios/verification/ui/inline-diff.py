"""Tool-detail inline diffs are native, full-height, and scroll with the sheet."""
import sys
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])
ui.axe('tap', '--label', 'Fixtures')
# UIKit exposes offscreen menu actions to AX; reveal the final row before tapping it.
row = ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == 'Process Counts Fixture'), None), 'Missing fixture menu')['frame']
x = str(row['x'] + row['width'] / 2)
ui.axe('drag', '--start-x', x, '--start-y', str(row['y'] + 10),
       '--end-x', x, '--end-y', str(row['y'] - 220), '--duration', '.5', '--post-delay', '.3')
ui.capture('fixture-menu-scrolled')
ui.axe('tap', '--label', 'Inline Diff Fixture')
ui.wait(
    lambda items: any(
        (i.get('AXUniqueId') or '') == 'inline-diff'
        or 'src/inline.ts' in (i.get('AXLabel') or '')
        for i in items
    ),
    'Inline diff sheet did not open',
)
lines = [
    item
    for item in ui.state()
    if item.get('AXUniqueId') == 'inline-diff-line'
]
assert lines, 'Native inline diff lines were missing from AX'
labels = ' '.join(item.get('AXLabel') or '' for item in lines)
assert 'greeting' in labels, labels
assert any('removed' in (item.get('AXLabel') or '') for item in lines)
assert any('added' in (item.get('AXLabel') or '') for item in lines)
ui.capture('inline')
height = sum(item['frame']['height'] for item in lines)
assert height >= 36, height
xs = {round(item['frame']['x']) for item in lines}
assert len(xs) == 1, xs
grabber = ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == 'Sheet Grabber'), None), 'Missing sheet grabber')['frame']
x = str(grabber['x'] + grabber['width'] / 2)
original_y = min(item['frame']['y'] for item in lines)
ui.axe('drag', '--start-x', x, '--start-y', str(grabber['y'] + grabber['height'] / 2),
       '--end-x', x, '--end-y', '90', '--duration', '.5', '--post-delay', '.3')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'inline-diff-line' and i['frame']['y'] < original_y - 50 for i in items),
        'Expanding the sheet did not move the native diff')
ui.capture('inline-expanded')
print('Inline native diff lines, height and sheet expansion passed')
