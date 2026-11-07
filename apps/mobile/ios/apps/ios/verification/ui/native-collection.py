"""Native collection rows extend behind the persistent navigation/search header."""
import sys
from driver import UI

ui = UI(sys.argv[1], sys.argv[2])


def scroll_under_header(identifier, screenshot):
    collection = ui.element(identifier)['frame']
    search = ui.element('poc-collection-search')['frame']
    assert collection['y'] < search['y'], (collection, search)
    first = ui.element('poc-collection-row-1')['frame']
    assert first['y'] >= search['y'] + search['height'], (first, search)
    ui.capture(screenshot + '-top')
    x = collection['x'] + collection['width'] / 2
    ui.axe('swipe', '--start-x', str(x), '--start-y', '650',
           '--end-x', str(x), '--end-y', '220', '--duration', '1', '--post-delay', '1')
    rows = [item for item in ui.state() if (item.get('AXUniqueId') or '').startswith('poc-collection-row-')]
    assert rows and not any(item.get('AXUniqueId') == 'poc-collection-row-1' for item in rows), rows
    search = ui.element('poc-collection-search')['frame']
    assert any(item['frame']['y'] < search['y'] + search['height'] for item in rows), (rows, search)
    ui.capture(screenshot + '-scrolled')


scroll_under_header('poc-native-collection', 'collection')
ui.axe('tap', '--id', 'poc-collection-search', '--tap-style', 'physical', '--post-delay', '.5')
ui.type_into('poc-collection-search', '30')
ui.element('poc-collection-row-30')
rows = [item for item in ui.state() if (item.get('AXUniqueId') or '').startswith('poc-collection-row-')]
assert len(rows) == 1, rows
ui.capture('collection-search')
ui.axe('tap', '--id', 'poc-collection-row-30', '--tap-style', 'physical', '--post-delay', '1')
scroll_under_header('poc-native-session', 'session')
ui.axe('tap', '--label', 'Collections', '--post-delay', '1')
ui.element('poc-native-collection')
ui.capture('collection-return')
ui.axe('tap', '--label', 'close', '--post-delay', '1')
ui.element('native-collection-poc')
print('PASS: native collection viewport under header; rows scroll behind persistent search in both hosts; filtering, push and return')
