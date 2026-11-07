"""Production Markdown supports code copy, selection, and clipped, horizontally scrolling tables."""
import json
import subprocess
import sys
import time
from pathlib import Path
from driver import UI
from flat_rows import _pixels
import catalog

ui = UI(*sys.argv[1:])


def table_bleed_path():
    container = subprocess.check_output(
        ['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'],
        text=True,
        timeout=10,
    ).strip()
    return Path(container) / 'tmp' / 'lody-table-bleed.json'


def table_bleed_rows():
    path = table_bleed_path()
    ui.wait(lambda _: path.exists() and path.stat().st_size > 2, 'Table bleed probe did not write')
    return json.loads(path.read_text())


def widest_table(rows):
    wide = [row for row in rows if row['contentWidth'] > row['boundsWidth'] + 8]
    assert wide, ('No horizontally scrollable table', rows)
    return max(wide, key=lambda row: row['y'])


def save_probe(name):
    path = table_bleed_path()
    if path.exists():
        (ui.output / f'{name}.probe.json').write_text(path.read_text())


copy_label = catalog.system('copy')
word_press_count = 0


def system_selection(name):
    path = table_bleed_path().with_name('lody-system-selection.json')
    def ready(_):
        if not path.exists():
            return None
        value = json.loads(path.read_text())
        displays = value['displays']
        return value if len(displays) == 1 and len(displays[0]['handles']) == 2 and displays[0]['rectCount'] > 0 else None
    value = ui.wait(ready, 'Selection must have exactly one UIKit display and two system handles')
    assert value['customHandles'] == 0, value
    (ui.output / (name + '-system-selection.json')).write_text(json.dumps(value, indent=2))


def copy_frames():
    return {
        tuple(item['frame'][key] for key in ('x', 'y', 'width', 'height'))
        for item in ui.state() if (item.get('AXLabel') or '').casefold() == copy_label.casefold() and item.get('frame')
    }


def long_press_copy(x, y):
    global word_press_count
    word_press_count += 1
    old = copy_frames()
    subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input='selection sentinel', text=True, check=True, timeout=10)
    ui.axe('touch', '-x', str(x), '-y', str(y), '--down')
    try:
        time.sleep(.8)
        ui.screenshot(f'word-loupe-{word_press_count}-held')
    finally:
        ui.axe('touch', '-x', str(x), '-y', str(y), '--up')
    action = ui.wait(
        lambda items: next((item for item in items
                            if (item.get('AXLabel') or '').casefold() == copy_label.casefold() and item.get('type') == 'GenericElement' and item.get('frame') and
                            tuple(item['frame'][key] for key in ('x', 'y', 'width', 'height')) not in old), None),
        'Long press did not open the selection menu')
    ui.capture('word-selection-before-copy')
    system_selection(f'word-{word_press_count}')
    probe = table_bleed_path().with_name('lody-markdown-selection.json')
    (ui.output / 'word-selection-before-copy.probe.json').write_text(probe.read_text())
    action = ui.wait(lambda items: next((i for i in items if (i.get('AXLabel') or '').casefold() == copy_label.casefold() and i.get('type') == 'GenericElement'), None), 'Copy menu disappeared')
    frame = action['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.3')
    def copied(_):
        value = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10).strip()
        return value if value and value != 'selection sentinel' else None
    return ui.wait(copied, 'Selection did not reach the clipboard', timeout=5)


rest = widest_table(table_bleed_rows())
assert rest['x'] >= rest['borderX'] - 1, rest
assert rest['x'] + rest['width'] <= rest['borderX'] + rest['borderWidth'] + 1, rest
assert rest['offsetX'] <= 1, rest
save_probe('table-bleed')
ui.capture('table-bleed')
# Use explicit down/move/up events before and after held touches. AXe swipe
# can report success without delivery once its HID broker owns the session.
# First prove ordinary scrolling before any selection owns the gesture.
ui.axe('drag', '--start-x', str(rest['x'] + rest['width'] - 48), '--start-y', str(rest['y'] + 60), '--end-x', str(rest['x'] + 48), '--end-y', str(rest['y'] + 60), '--duration', '.35', '--post-delay', '.5')
plain_scroll = widest_table(table_bleed_rows())
assert plain_scroll['offsetX'] > 20, ('Unselected table did not scroll', plain_scroll)
save_probe('table-before-return')
# Opposite drags need not cancel UIKit's velocity and deceleration.
for attempt in range(3):
    current = widest_table(table_bleed_rows())
    if current['offsetX'] <= 1:
        break
    ui.axe('drag', '--start-x', str(current['x'] + 48), '--start-y', str(current['y'] + 60), '--end-x', str(current['x'] + current['width'] - 48), '--end-y', str(current['y'] + 60), '--duration', '.35', '--post-delay', '.5')
    save_probe(f'table-return-{attempt + 1}')
ui.wait(lambda _: abs(widest_table(table_bleed_rows())['offsetX']) <= 1, 'Table did not return to its start')
save_probe('table-returned')
ui.capture('table-returned')
assert '<ruby>日本語<rt>にほんご</rt></ruby>' in ui.element('preview:answer')['AXLabel']
ui.capture('ruby-annotations')
cell_word = long_press_copy(rest['x'] + rest['contentLeft'] + 24, rest['y'] + 16)
assert cell_word in 'table-bleed-start', repr(cell_word)
ui.capture('table-selection')
mid_y = rest['y'] + min(40, rest['height'] / 2)
for _ in range(3):
    if widest_table(table_bleed_rows())['offsetX'] > 20:
        break
    ui.axe(
        'drag',
        '--start-x', str(rest['x'] + rest['width'] - 48),
        '--start-y', str(mid_y),
        '--end-x', str(rest['x'] + 48),
        '--end-y', str(mid_y),
        '--duration', '.35',
        '--post-delay', '.5',
    )
ui.wait(
    lambda _: widest_table(table_bleed_rows())['offsetX'] > 20,
    'Wide table did not scroll horizontally',
)
scrolled = widest_table(table_bleed_rows())
assert scrolled['x'] >= scrolled['borderX'] - 1, scrolled
assert scrolled['x'] + scrolled['width'] <= scrolled['borderX'] + scrolled['borderWidth'] + 1, scrolled
save_probe('table-bleed-scrolled')
ui.capture('table-bleed-scrolled')

for _ in range(16):
    # AX exposes code actions beneath the transparent navigation bar; scroll them clear before tapping.
    copies = [i['frame'] for i in ui.state()
              if (i.get('AXLabel') or '').casefold() == copy_label.casefold() and i.get('type') == 'Button'
              and i.get('frame', {}).get('height', 0) >= 40
              and 140 <= i.get('frame', {}).get('y', 0) <= 650]
    if copies:
        copy = max(copies, key=lambda frame: frame['y'])
        break
    ui.axe('drag', '--start-x', '200', '--start-y', '400', '--end-x', '200', '--end-y', '500', '--duration', '.8', '--post-delay', '1')
else:
    raise AssertionError('Markdown code copy action not visible')
# AX can report a prefetched row while the preceding swipe is still settling.
# Re-resolve the visible code button until its geometry stops moving.
last_copy = None


def settled_code_copy(items):
    global last_copy
    frames = [i['frame'] for i in items
              if (i.get('AXLabel') or '').casefold() == copy_label.casefold() and i.get('type') == 'Button'
              and i.get('frame', {}).get('height', 0) >= 40
              and 140 <= i.get('frame', {}).get('y', 0) <= 650]
    current = max(frames, key=lambda frame: frame['y']) if frames else None
    settled = current is not None and current == last_copy
    last_copy = current
    return current if settled else None


def assert_code_fill(ui, copy):
    window = ui.state()[0]['frame']
    width, height, data = _pixels(ui.output / 'code-copy-target.png')
    scale = width / window['width']
    x = round((copy['x'] + 2) * scale)
    bar_y = round((copy['y'] + copy['height'] / 2) * scale)
    body_y = round((copy['y'] + copy['height'] - 2) * scale)
    assert 0 <= x < width and 0 <= bar_y < body_y < height, ('Code fill samples are offscreen', copy)
    bar = data[bar_y * width + x]
    body = data[body_y * width + x]
    assert abs(bar - body) < 4, f'Code top bar and body must share one fill ({bar} vs {body})'


copy = ui.wait(settled_code_copy, 'Code Copy button did not settle')
ui.capture('code-copy-target')
assert_code_fill(ui, copy)
subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input='clipboard sentinel', text=True, check=True, timeout=10)
ui.axe('tap', '-x', str(copy['x'] + copy['width'] / 2), '-y', str(copy['y'] + copy['height'] / 2), '--post-delay', '.3')
text = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10)
assert text.strip() == 'let layout = UICollectionViewFlowLayout()\nlet list = UICollectionView(\n  frame: .zero,\n  collectionViewLayout: layout\n)', repr(text)

for _ in range(8):
    answer = ui.element('preview:answer')
    frame = answer['frame']
    if frame['y'] + frame['height'] <= 750:
        break
    ui.axe('drag', '--start-x', '200', '--start-y', '650', '--end-x', '200', '--end-y', '350', '--duration', '.5', '--post-delay', '.3')
selected = long_press_copy(frame['x'] + 70, frame['y'] + frame['height'] - 25)
assert selected in answer['AXLabel'], repr(selected)
ui.capture('markdown-code')

grown = table_bleed_path().with_name('lody-context-view-grown.json')
grown.unlink(missing_ok=True)
hit_testing = grown.with_name('lody-markdown-hit-testing.json')
hit_testing.unlink(missing_ok=True)
ui.axe('tap', '--label', 'Fast Replay', '--post-delay', '.5')
ui.wait(
    lambda items: any(i.get('AXUniqueId') == 'preview:answer' and (i.get('AXLabel') or '').endswith('收尾段落。') for i in items),
    'Fast replay did not complete',
)
time.sleep(1)
assert not grown.exists(), ('Code or table view animated its frame after completion', grown.read_text())
ui.wait(lambda _: hit_testing.exists(), 'Fold hit-testing checks did not run')
checks = json.loads(hit_testing.read_text())
assert checks and all(checks.values()), checks
(ui.output / 'markdown-hit-testing.json').write_text(hit_testing.read_text())
ui.capture('markdown-folded')
print('PASS: production Markdown code copy, long-press selection in body and table, clipped table viewport, and fold without regrowth')

# Small production rows make both boundaries reachable without scrolling.
ui.axe('tap', '--label', 'Fixtures', '--post-delay', '.3')
ui.axe('tap', '--label', 'Selection Fixture', '--post-delay', '.5')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'selection:first' for i in items), 'Selection fixture did not load')
selection_path = table_bleed_path().with_name('lody-markdown-selection.json')


def labels():
    return json.loads(selection_path.read_text())


def label(text):
    return next((item for item in labels() if item['text'].strip() == text), None)


def press(text):
    item = ui.wait(lambda _: label(text), f'Missing rendered label: {text}')
    x, y = item['x'] + 15, item['y'] + item['height'] / 2
    ui.axe('touch', '-x', str(x), '-y', str(y), '--down')
    try:
        time.sleep(.8)
        ui.screenshot('selection-loupe-' + text.split()[0].lower())
        system_selection('held-' + text.split()[0].lower())
    finally:
        ui.axe('touch', '-x', str(x), '-y', str(y), '--up')
    return ui.wait(lambda _: next((i for i in labels() if i['text'].strip() == text and i.get('rects')), None), 'Word selection did not appear')


def extend(selected, target, name):
    rect = selected['rects'][-1]
    # Capture the actual system loupe while the finger is still dragging. After
    # release the loupe must disappear and the menu/clipboard checks resume.
    command = ['axe', 'drag', '--udid', ui.udid,
               '--start-x', str(rect['x'] + rect['width']), '--start-y', str(rect['y'] + rect['height'] + 4),
               '--end-x', str(target['x'] + target['width'] + 8), '--end-y', str(target['y'] + target['height'] / 2 + 8),
               '--duration', '3', '--steps', '180', '--post-delay', '.5']
    drag = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        time.sleep(1.5)
        assert drag.poll() is None, 'Selection drag ended before its held capture'
        ui.screenshot(name + '-loupe-dragging')
    finally:
        stdout, stderr = drag.communicate(timeout=20)
    assert drag.returncode == 0, (stdout, stderr)


def copy_selection():
    action = ui.wait(lambda items: next((i for i in items if (i.get('AXLabel') or '').casefold() == 'copy' and i.get('type') == 'GenericElement' and i.get('frame')), None), 'Selection Copy menu missing')
    frame = action['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.3')
    return subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10)


selected = press('Alpha begins here.')
extend(selected, label('Bravo finishes here.'), 'cross-row')
ui.wait(lambda _: sum(bool(i.get('selected')) for i in labels()) >= 2, 'Handle did not cross Markdown rows')
ui.capture('cross-row-selection')
system_selection('cross-row')
copied = copy_selection()
assert 'Alpha begins here.' in copied and 'Bravo finishes here' in copied, repr(copied)
(ui.output / 'cross-row-copy.txt').write_text(copied)

selected = press('Fruit')
extend(selected, label('Red'), 'cross-table')
ui.wait(lambda _: sum(bool(i.get('selected')) for i in labels()) >= 4, 'Handle did not cross table cells')
ui.capture('cross-table-selection')
system_selection('cross-table')
copied = copy_selection()
assert 'Fruit\tColor\nApple\tRed' in copied, repr(copied)
(ui.output / 'cross-table-copy.txt').write_text(copied)
ui.axe('tap', '--label', 'Fast Replay', '--post-delay', '.5')
# Selection pauses bottom-following; replacement history need not scroll to its last row.
ui.wait(lambda items: any((i.get('AXUniqueId') or '').startswith('history-') for i in items), 'Replacement transcript did not display history')
ui.wait(lambda _: not any(i.get('selected') for i in labels()), 'Replaced rows retained stale selection')
ui.capture('selection-reset')
print('PASS: drag handles cross Markdown rows and table cells; copy preserves order and tab/newline separators; replaced rows clear selection')
