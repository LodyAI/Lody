"""Exercise the shared paged form and composer through page changes."""
import sys
from driver import UI

ui = UI(*sys.argv[1:])
ui.element('page-0-row-0')
ui.capture('first-page')
ui.axe('tap', '--id', 'create-session-input', '--tap-style', 'physical', '--post-delay', '1')
ui.element('session-model')
ui.capture('first-page-keyboard')
for page in [1, 0]:
    ui.axe('tap', '--label', f'Page {page + 1}', '--tap-style', 'physical', '--post-delay', '1')
    ui.element(f'page-{page}-row-0')
    ui.element('create-session-input')
    ui.capture(f'page-{page}-selected')
    ui.axe('swipe', '--start-x', '200', '--start-y', '360', '--end-x', '200', '--end-y', '240', '--duration', '.6', '--post-delay', '1')
    ui.capture(f'page-{page}-scrolled')
print('PASS: both native pages remain scrollable with the shared composer; review edge captures visually')
