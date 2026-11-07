"""Native item details: retry, retained pagination, raw payloads and live revision."""
import sys
from driver import UI
ui = UI(*sys.argv[1:])

def tap(id):
    button = ui.element(id)
    assert button['frame']['height'] >= 44, button
    ui.axe('tap', '--id', id)

def has(text):
    ui.wait(lambda items: any(text in (i.get('AXLabel') or '') or text in str(i.get('AXValue') or '') for i in items), text)

ui.element('item-detail-error-item')
ui.capture('initial-failure')
tap('item-detail-retry-item')
has('Revision 1 output')
# Expand the sheet so both data and controls remain visible.
grabber = next(i['frame'] for i in ui.state() if i.get('AXLabel') == 'Sheet Grabber')
x = str(grabber['x'] + grabber['width'] / 2)
ui.axe('drag', '--start-x', x, '--start-y', str(grabber['y'] + grabber['height'] / 2),
       '--end-x', x, '--end-y', '90', '--duration', '.5', '--post-delay', '.3')
ui.capture('loaded')
tap('item-detail-raw-item:input')
has('raw input')
ui.capture('raw-input')
tap('item-detail-raw-item:input')
tap('item-detail-raw-item:output')
has('raw output')
ui.capture('raw-output')
tap('item-detail-raw-item:output')
tap('item-detail-more-item')
ui.element('item-detail-retry-item')
has('Revision 1 output')
ui.capture('pagination-failure-retains-content')
tap('item-detail-retry-item')
has('Second page output')
assert not any(i.get('AXUniqueId') == 'item-detail-more-item' for i in ui.state())
ui.capture('appended-page')
ui.axe('tap', '--label', 'Update')
has('Revision 2 output')
assert not any('Second page output' in str(i.get('AXLabel') or '') + str(i.get('AXValue') or '') for i in ui.state())
ui.capture('revision-replaces-pages')
ui.axe('tap', '--label', 'Done')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'item-detail-scroll' for i in items), 'Detail sheet did not close')
print('PASS: native item detail loading/retry, raw input/output, paging failure/retry and live revision')
