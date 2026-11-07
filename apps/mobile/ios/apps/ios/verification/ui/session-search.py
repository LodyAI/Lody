"""Real Inbox/sidebar → cached conversation → native find, without cloud."""
import json
import subprocess
import sys
from driver import UI
import catalog
import pad as pad_layout

ui = UI(sys.argv[1], sys.argv[2])
pad = any(i.get('AXUniqueId') == 'ipad-home' for i in ui.state())


def tap(item):
    frame = item['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.4')


def inbox_field():
    return ui.wait(lambda items: next((i for i in items
        if (i.get('subrole') == 'AXSearchField' or i.get('AXUniqueId') == 'sidebar-search') and i.get('AXUniqueId') != 'chat-find-field'), None),
        'Missing Inbox search field')


def replace(field, text):
    tap(field)
    field = ui.element(field['AXUniqueId']) if field.get('AXUniqueId') else inbox_field()
    frame = field['frame']
    clear = next((i for i in ui.state() if i.get('AXLabel') == catalog.system('clear')
                  and frame['x'] <= i['frame']['x'] < frame['x'] + frame['width']
                  and frame['y'] <= i['frame']['y'] < frame['y'] + frame['height']), None)
    if clear:
        tap(clear)
        tap(field)
    if pad:
        # iPad fields paste the host pasteboard unreliably; batch-type the query instead.
        ui.restore_software_keyboard()
        ui.wait(ui.keyboard_ready, 'Search keyboard did not become visible')
        ui.axe('type', text)
        current = ui.element(field['AXUniqueId']) if field.get('AXUniqueId') else inbox_field()
        assert (current.get('AXValue') or '').casefold() == text.casefold(), current
        return
    # Paste the query as one batch; HID typing can retain Shift across searches.
    subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input=text, text=True, check=True)
    ui.restore_software_keyboard()
    ui.wait(ui.keyboard_ready, 'Search keyboard did not become visible')
    field = ui.element(field['AXUniqueId']) if field.get('AXUniqueId') else inbox_field()
    frame = field['frame']
    ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
    paste = ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == 'Paste'), None), 'Missing search paste action')
    tap(paste)
    current = ui.element(field['AXUniqueId']) if field.get('AXUniqueId') else inbox_field()
    assert current.get('AXValue') == text, current


def search(text):
    if pad:
        pad_layout.show_list(ui)
    if not pad and not any(i.get('subrole') == 'AXSearchField' for i in ui.state()):
        ui.axe('tap', '--id', 'magnifyingglass', '--post-delay', '.6')
    replace(inbox_field(), text)


def empty_search():
    ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('search.placeholder.noMatch') for i in items),
            'Missing content-search scope in empty state')


def count(value):
    return ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == 'chat-find-count'
                    and i.get('AXLabel') == value), None), f'Find count did not become {value}')


def keyboard(items):
    return any((i.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar') for i in items)


def find_layout():
    assert ui.element('chat-find-close')['AXLabel'] == catalog.text('native.chat.find.done')
    field = ui.element('chat-find-field')['frame']
    close = ui.element('chat-find-close')['frame']
    previous = ui.element('chat-find-previous')['frame']
    following = ui.element('chat-find-next')['frame']
    assert field['width'] >= 220, ('Search input is cramped', field)
    assert abs(field['y'] - close['y']) < 2, (field, close)
    assert previous['y'] >= field['y'] + field['height'], (field, previous)
    assert abs(previous['y'] - following['y']) < 2, (previous, following)
    for frame in [close, previous, following]:
        assert frame['width'] >= 44 and frame['height'] >= 44, frame
    return field


def back_to_inbox():
    if pad:
        pad_layout.show_list(ui)
    else:
        ui.axe('tap', '--id', 'BackButton', '--post-delay', '.7')
    inbox_field()


def highlight_probe(name, expected=True):
    """Read actual highlight layers and their screen coordinates, never mutate UI."""
    # The app reports its rendered layers; attaching a debugger here left the app unresponsive to AX and taps.
    layers = json.loads(ui.element('chat-find-probe').get('AXValue') or '[]')
    (ui.output / f'{name}-highlights.json').write_text(json.dumps(layers, indent=2))
    if not expected:
        assert not layers, 'Closing find left highlight layers behind'
        return
    active = [r for r in layers if r['active']]
    assert active, ('No active rendered highlight', layers)
    field = ui.element('chat-find-field')['frame']
    composer = ui.element('session-input')['frame']
    assert any(r['width'] > 0 and r['height'] > 0 and r['y'] >= field['y'] + field['height']
               and r['y'] + r['height'] <= composer['y'] for r in active), ('Active match is not visible', active)


search('Search')
ui.element('ui-search')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'ui-design' for i in items), 'Title filter failed')
search('/tmp/lody-ios')
ui.element('project:ui:local:lody')
search('feature/session-model')
ui.element('ui-design')
search('tool-only')
empty_search()
search('private-marker')
empty_search()
ui.capture('no-match-scope')
search('needle')
row = ui.element('ui-design')
ui.wait(lambda items: any('needle from user' in (i.get('AXLabel') or '') for i in items),
        'Body hit did not replace the row subtitle')
ui.capture('inbox-body-snippet')
tap(row)
count('6 / 6')
initial_field = find_layout()
ui.wait(lambda items: not keyboard(items), 'Inbox find opened a keyboard')
assert (ui.element('chat-find-field').get('AXValue') or '').lower() == 'needle'
ui.capture('last-match-table')
highlight_probe('last-match-table')
for value in range(5, 0, -1):
    ui.axe('tap', '--id', 'chat-find-previous', '--post-delay', '.2')
    count(f'{value} / 6')
ui.capture('first-match-user')
highlight_probe('first-match-user')
for value in range(2, 7):
    ui.axe('tap', '--id', 'chat-find-next', '--post-delay', '.2')
    count(f'{value} / 6')
    if value in [2, 4, 5]:
        ui.capture(f'match-{value}')
        highlight_probe(f'match-{value}')
answer_before_close = ui.element('search-answer:answer')['frame']
ui.axe('tap', '--id', 'chat-find-close', '--post-delay', '.4')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'chat-find-field' for i in items), 'Find did not close')
answer_after_close = ui.element('search-answer:answer')['frame']
assert abs(answer_before_close['y'] - answer_after_close['y']) <= 1, 'Closing find moved the message'
ui.capture('find-closed-position')
highlight_probe('closed', expected=False)

more = ui.wait(lambda items: max((i for i in items if i.get('AXLabel') == catalog.text('common.more')
                                and i.get('type') == 'Button'), key=lambda i: i['frame']['x'], default=None), 'Missing session menu')
tap(more)
ui.axe('tap', '--label', catalog.text('session.action.find'), '--post-delay', '.5')
ui.wait(keyboard, 'Manual find did not focus the search field')
replace(ui.element('chat-find-field'), 'needle')
count('6 / 6')
find_layout()
tap(ui.element('Search'))
count('1 / 6')
ui.capture('manual-find-keyboard')
replace(ui.element('chat-find-field'), 'crossformatbody')
count('1 / 1')
assert find_layout()['width'] == initial_field['width'], 'Result count resized the input'
ui.capture('cross-inline-match')
highlight_probe('cross-inline-match')
answer_before_close = ui.element('search-answer:answer')['frame']
ui.axe('tap', '--id', 'chat-find-close', '--post-delay', '.4')
ui.wait(lambda items: not keyboard(items), 'Closing find left the keyboard open')
answer_after_close = ui.element('search-answer:answer')['frame']
assert abs(answer_before_close['y'] - answer_after_close['y']) <= 1, 'Keyboard dismissal moved the message'
ui.capture('find-keyboard-closed-position')

back_to_inbox()
search('hidden-only')
tap(ui.element('ui-design'))
count(catalog.text('native.chat.find.noResults'))
assert not any('hidden-only thought' == i.get('AXLabel') for i in ui.state()), 'Find expanded the process'
ui.capture('collapsed-hit-no-navigation')
back_to_inbox()
search('ancient-signal')
tap(ui.element('ui-search'))
count(catalog.text('native.chat.find.noResults'))
ui.element('chat-find-scope')
ui.element('search-history-61:answer')
assert not any(i.get('AXUniqueId') == 'search-history-0:answer' for i in ui.state())
ui.capture('outside-window-latest-result')

# Search does not grow the window. Explicitly scroll to its header and load it.
for _ in range(24):
    header = next((i for i in ui.state() if i.get('AXUniqueId') == 'chat-history'
                   and i.get('AXLabel') == catalog.text('native.chat.history.more')
                   and i['frame']['y'] > ui.element('chat-find-next')['frame']['y'] + 44), None)
    if header:
        tap(header)
        break
    area = ui.element('chat-transcript')['frame']
    x = area['x'] + area['width'] * .75
    top = ui.element('chat-find-field')['frame']['y'] + 100
    bottom = ui.element('session-input')['frame']['y'] - 30
    ui.axe('drag', '--start-x', str(x), '--start-y', str(top), '--end-x', str(x),
           '--end-y', str(bottom), '--duration', '.35', '--post-delay', '.2')
else:
    raise AssertionError('Could not reach the explicit history load control')
count('1 / 1')
ui.axe('tap', '--id', 'chat-find-next', '--post-delay', '.4')
ui.element('search-history-0:answer')
ui.capture('loaded-history-match')
highlight_probe('loaded-history-match')
print('PASS: catalog/body search, Markdown-safe snippet, last/previous/next matches, keyboard, close, folded and paged results')
