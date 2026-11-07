"""The sheet's grabber drags the chat input to full screen with a format bar, back down, and closes the sheet."""
import sys
from driver import UI

ui = UI(*sys.argv[1:])


def frame(identifier):
    return ui.element(identifier)['frame']


# AXe also lists hidden UIKit views, so a clipped control counts only when it has height.
def visible(identifier):
    return any(item.get('AXUniqueId') == identifier and item.get('frame', {}).get('height', 0) > 0 for item in ui.state())


def drag_grabber(to_y, duration='.6'):
    grip = frame('session-grabber')
    x = grip['x'] + grip['width'] / 2
    y = grip['y'] + grip['height'] / 2
    ui.axe('swipe', '--start-x', str(x), '--start-y', str(y), '--end-x', str(x), '--end-y', str(to_y),
           '--duration', duration, '--delta', '2', '--post-delay', '.9')


ui.axe('tap', '--id', 'session-input', '--tap-style', 'physical', '--post-delay', '.8')
ui.axe('type', ' '.join(f'word{index}' for index in range(60)))
ui.wait(lambda items: visible('session-grabber'), 'The open sheet has no grabber')
assert not visible('session-expand'), 'The expand button must be gone'
inline = frame('session-input')
inline_top = frame('session-grabber')['y']
assert inline['height'] <= 142, f'Inline input exceeded its cap: {inline}'
assert not visible('composer-format-bold'), 'Format bar is visible before expanding'
ui.capture('overflow')

drag_grabber(120)
# The sheet's chrome (attachments, grabber, format bar, toolbar) can absorb most of a short host's height, so growth is measured at the sheet's top edge.
ui.wait(lambda items: frame('session-grabber')['y'] < inline_top - 30 and visible('composer-format-bold'),
        'Dragging the grabber up did not open full screen with the format bar')
full = frame('session-input')
assert full['height'] >= inline['height'] - 1, f'Full-screen input shrank: {full}'
for name in ['heading', 'bold', 'italic', 'strikethrough', 'code', 'bulletList', 'quote']:
    assert visible(f'composer-format-{name}'), f'Format bar lacks {name}'
ui.capture('fullscreen')

ui.axe('tap', '--id', 'composer-format-bold', '--post-delay', '.3')
ui.axe('type', 'bold')
ui.wait(lambda items: 'bold' in (ui.element('session-input').get('AXValue') or ''), 'Typing after Bold did not reach the input')
ui.capture('formatted')

grip = frame('session-grabber')
drag_grabber(grip['y'] + 260)
ui.wait(lambda items: frame('session-input')['height'] <= 142 and not visible('composer-format-bold'),
        'Dragging the grabber down did not return to the default sheet')
assert visible('session-send'), 'Dragging down from full screen must keep the sheet open'
ui.capture('collapsed')

ui.axe('tap', '--id', 'session-grabber', '--post-delay', '.9')
ui.wait(lambda items: frame('session-grabber')['y'] < inline_top - 30 and visible('composer-format-bold'), 'Tapping the grabber did not open full screen')
ui.axe('tap', '--id', 'session-send', '--post-delay', '1.2')
ui.wait(lambda items: not visible('composer-format-bold') and not (ui.element('session-input').get('AXValue') or ''),
        'Send did not collapse and clear the full-screen input')
ui.capture('sent')

grip = frame('session-grabber')
drag_grabber(grip['y'] + 220, duration='.4')
ui.wait(lambda items: abs(frame('session-input')['height'] - 48) <= 1, 'Dragging the default sheet down did not close it')
ui.capture('closed')
print('PASS: grabber drag to full screen with format bar, drag back, tap toggle, send collapse, and drag-down close')
