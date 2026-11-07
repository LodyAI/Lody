"""Capture content under the floating composer; review the chat bottom edge fade visually."""
import sys
from driver import UI

ui = UI(*sys.argv[1:])
resting = ui.element('session-input')['frame']
ui.axe('swipe', '--start-x', '200', '--start-y', '340', '--end-x', '200',
       '--end-y', '530', '--duration', '1', '--post-delay', '1')
ui.element('chat-scroll-to-bottom')
ui.capture('chat-edge-fade-scrolled')
ui.axe('tap', '--id', 'session-input', '--tap-style', 'physical', '--post-delay', '1')
ui.wait(lambda items: any((item.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar')
                         for item in items), 'Software keyboard did not appear')
raised = ui.element('session-input')['frame']
assert raised['y'] < resting['y'] - 100, 'Composer did not rise above the keyboard'
ui.capture('chat-edge-fade-keyboard')
print('PASS: scrolled content and keyboard states captured; the edge fade requires visual review')
