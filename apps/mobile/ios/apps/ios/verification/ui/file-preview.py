"""File links open documents, code and Quick Look, and return to their owning chat."""
import json
import os
import subprocess
from pathlib import Path
import sys
import time
from driver import UI
import catalog
ui = UI(*sys.argv[1:])
container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
probe = Path(container) / 'tmp/lody-file-source.json'
def geometry(name):
    value = json.loads(probe.read_text())
    (ui.output / (name + '.probe.json')).write_text(json.dumps(value, indent=2))
    return value

def title(name, timeout=30):
    return ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == name for i in items), 'Wrong file opened: ' + name, timeout)

def link(index, row='file-links:answer', icon=False):
    frame = ui.element(row)['frame']
    # Production Markdown paragraphs: 24pt line + 8pt paragraph spacing.
    # Geometry is relative to the current native cell, including inside a sheet.
    ui.axe('tap', '-x', str(frame['x'] + (8 if icon else 55)), '-y', str(frame['y'] + 16 + index * 32), '--post-delay', '.6')

def back(label=None):
    if label:
        ui.axe('tap', '--label', label, '--post-delay', '.5')
        return
    buttons = [i for i in ui.state() if (i.get('AXUniqueId') or '') == 'file-back']
    if buttons:
        assert str(buttons[-1].get('AXLabel') or '').casefold() == catalog.text('native.close').casefold(), buttons[-1]
        frame = buttons[-1]['frame']
        ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.5')
        return
    ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')

def dismiss_quicklook():
    frame = ui.element('QLPreviewControllerView')['frame']
    grabber = next((i.get('frame') for i in ui.state() if i.get('AXLabel') == 'Sheet Grabber'), None)
    start_y = grabber['y'] + grabber['height'] / 2 if grabber else max(frame['y'] + 16, 70)
    ui.axe(
        'drag',
        '--start-x', str(frame['x'] + frame['width'] / 2),
        '--start-y', str(start_y),
        '--end-x', str(frame['x'] + frame['width'] / 2),
        '--end-y', str(frame['y'] + min(frame['height'] - 24, 720)),
        '--duration', '.5',
        '--post-delay', '.7',
    )
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'QLPreviewControllerView' for i in items), 'Presented Quick Look did not dismiss with a drag')

def quicklook_loaded():
    ui.element('QLPreviewControllerView')
    close = ui.element('file-quicklook-close')
    assert close['enabled'], close
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'file-loading' for i in items), 'Quick Look file did not finish loading')
    ui.element('QLOverlayMarkupButtonAccessibilityIdentifier')


def document_selection(name):
    frame = ui.element('file-document-content')['frame']
    x, y = frame['x'] + 20, frame['y'] + 18
    ui.axe('touch', '-x', str(x), '-y', str(y), '--down')
    try:
        time.sleep(.8)
        ui.screenshot(name + '-loupe-held')
    finally:
        ui.axe('touch', '-x', str(x), '-y', str(y), '--up')
    copy = catalog.system('copy')
    action = ui.wait(lambda items: next((item for item in items if
        (item.get('AXLabel') or '').casefold() == copy.casefold() and
        item.get('type') == 'GenericElement' and item.get('frame')), None),
        'Document selection did not restore its Copy menu')
    ui.capture(name + '-selection-released')
    display_probe = Path(container) / 'tmp/lody-system-selection.json'
    def native_selection(_):
        if not display_probe.exists():
            return None
        value = json.loads(display_probe.read_text())
        displays = value['displays']
        return value if len(displays) == 1 and len(displays[0]['handles']) == 2 else None
    display = ui.wait(native_selection, 'Document did not show one native selection with two handles')
    assert display['customHandles'] == 0, display
    (ui.output / (name + '-system-selection.json')).write_text(json.dumps(display, indent=2))
    button = action['frame']
    ui.axe('tap', '-x', str(button['x'] + button['width'] / 2),
           '-y', str(button['y'] + button['height'] / 2), '--post-delay', '.3')
    copied = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True).strip()
    assert copied == 'Performance', repr(copied)
    (ui.output / (name + '-copy.txt')).write_text(copied)
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] - 12), '-y', str(y), '--post-delay', '.3')

if os.environ.get('LODY_VERIFY_FILE_SELECTION_ONLY') == '1':
    ui.axe('tap', '--label', 'File Browser', '--post-delay', '.5')
    ui.axe('tap', '--id', 'entry:report.md', '--post-delay', '.2')
    title('report.md')
    ui.element('file-document')
    document_selection('browser-document')
    back()
    back()
    ui.element('file-links:answer')
    link(0)
    title('report.md')
    ui.element('file-document')
    document_selection('chat-document')
    back()
    ui.axe('tap', '--id', 'file-links:process', '--post-delay', '.6')
    ui.element('file-links:thought')
    link(0, row='file-links:thought')
    title('report.md')
    ui.element('file-document')
    document_selection('process-document')
    back()
    ui.element('file-links:thought')
    print('PASS: browser, chat and process documents use one system selection, two native handles and no custom handles; held loupe and released Copy produce Performance')
    sys.exit(0)

assert ui.element('file-links:answer')['custom_actions'] == ['完整报告', '代码', '图片', 'PDF 文档', '不存在的文件', '读取失败']
ui.capture('links')
ui.axe('tap', '--label', 'File Browser', '--post-delay', '.5')
ui.element('entry:report.md')
ui.capture('browser-list')
ui.axe('tap', '--id', 'entry:report.md', '--post-delay', '.2')
title('report.md', timeout=2)
ui.element('file-loading', timeout=2)
ui.capture('browser-loading')
ui.element('file-document')
ui.capture('browser-document')
document_selection('browser-document')
# A short, slow pull cancels the sheet return.
ui.axe('drag', '--start-x', '201', '--start-y', '80', '--end-x', '201', '--end-y', '160', '--duration', '.8', '--post-delay', '.6')
title('report.md')
ui.element('file-document')
ui.capture('browser-cancelled-return')
back()
row = ui.element('entry:report.md')
assert 'selected' not in str(row.get('traits') or []).lower(), row
ui.capture('browser-return')
ui.axe('tap', '--id', 'entry:sample.swift', '--post-delay', '.2')
title('sample.swift')
ui.element('file-source')
plain = geometry('browser-code')
assert plain['line'] == 0 and not plain['highlighted'], plain
ui.axe('drag', '--start-x', '220', '--start-y', '650', '--end-x', '220', '--end-y', '300', '--duration', '.5', '--post-delay', '.6')
ui.wait(lambda _: geometry('browser-code-scroll')['y'] > plain['y'] + 100, 'Source did not scroll vertically')
ui.capture('browser-code-scroll')
back()
back()
ui.element('file-links:answer')
link(0, icon=True)
title('report.md')
ui.element('file-document')
ui.wait(lambda items: any('Performance report' in (i.get('AXLabel') or '') for i in items), 'Markdown content missing')
ui.wait(lambda items: any('Ruby: <ruby>Tokyo<rt>toh-kee-oh</rt></ruby>.' in (i.get('AXLabel') or '') for i in items), 'Ruby base text missing from Markdown preview')
ui.capture('markdown')
document_selection('chat-document')
ui.axe('tap', '--label', catalog.text('file.source'), '--post-delay', '.4')
source = ui.element('file-source')
assert geometry('markdown-source')['sourceMatches']
ui.capture('source')
ui.axe('tap', '--label', catalog.text('file.preview'), '--post-delay', '.4')
ui.element('file-document')
# The document's own relative file link resolves next to docs/report.md.
doc = ui.element('file-document-content')
frame = doc['frame']
ui.axe('tap', '-x', str(frame['x'] + 60), '-y', str(frame['y'] + frame['height'] - 10), '--post-delay', '.5')
title('sample.swift')
ui.element('file-source')
ui.capture('relative-file')
back()
title('report.md')
back()
ui.element('file-links:answer')
ui.wait(lambda items: not any((i.get('AXUniqueId') or '') in ['file-back', 'QLPreviewControllerView'] for i in items), 'File sheet still open after dismiss')
link(1)
title('sample.swift')
source = ui.element('file-source')
ui.wait(lambda _: geometry('code-ready').get('line') == 120, 'Target code did not render')
ui.capture('code')
initial = geometry('code-target')
assert initial['line'] == 120 and initial['highlighted'], initial
assert initial['sourceMatches'], initial
assert initial['coloredTokens'] > 0, initial
assert initial['top'] < initial['targetY'] < initial['bottom'] - initial['targetHeight'], initial
assert initial['contentWidth'] > initial['width'] * 2, initial
assert initial['contentHeight'] > initial['height'] * 2, initial
# Real gestures must move the source in both axes without wrapping it.
ui.axe('drag', '--start-x', '330', '--start-y', '440', '--end-x', '100', '--end-y', '440', '--duration', '.5', '--post-delay', '.6')
ui.wait(lambda _: geometry('code-horizontal')['x'] > initial['x'] + 80, 'Source did not scroll horizontally')
horizontal = geometry('code-horizontal')
assert horizontal['x'] > initial['x'] + 80, horizontal
ui.capture('code-horizontal')
ui.axe('drag', '--start-x', '220', '--start-y', '650', '--end-x', '220', '--end-y', '300', '--duration', '.5', '--post-delay', '.6')
ui.wait(lambda _: geometry('code-vertical')['y'] > initial['y'] + 100, 'Source did not scroll vertically')
vertical = geometry('code-vertical')
assert vertical['y'] > initial['y'] + 100, vertical
ui.capture('code-vertical')
for _ in range(8):
    current = geometry('code-bottom')
    if current['y'] + current['bottom'] >= current['contentHeight'] - 2:
        break
    ui.axe('drag', '--start-x', '220', '--start-y', '700', '--end-x', '220', '--end-y', '240', '--duration', '.25', '--post-delay', '.6')
    ui.wait(lambda _: geometry('code-bottom')['y'] > current['y'], 'Source did not advance toward its final line')
last = geometry('code-bottom')
assert last['y'] + last['bottom'] >= last['contentHeight'] - 2, last
ui.capture('code-bottom')
# Interactive sheet dismissal must release useOpenFile's in-flight promise.
ui.axe('drag', '--start-x', '201', '--start-y', '65', '--end-x', '201', '--end-y', '740', '--duration', '.5', '--post-delay', '.7')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'file-back' for i in items), 'Source sheet did not dismiss')
ui.element('file-links:answer')
link(1)
title('sample.swift', timeout=3)
ui.element('file-source')
ui.wait(lambda _: geometry('code-reopened').get('handle') != initial['handle'], 'Reopened source did not render fresh content')
reopened = geometry('code-reopened')
assert reopened['top'] < reopened['targetY'] < reopened['bottom'] - reopened['targetHeight'], reopened
ui.capture('code-reopened')
back()
ui.axe('tap', '--id', 'file-links:process', '--post-delay', '.6')
ui.element('file-links:thought')
time.sleep(.8)
ui.capture('process-links')
link(0, row='file-links:thought')
title('report.md')
ui.element('file-document')
ui.capture('process-document')
document_selection('process-document')
ui.axe('tap', '--label', catalog.text('file.source'), '--post-delay', '.4')
ui.element('file-source')
ui.axe('tap', '--label', catalog.text('file.preview'), '--post-delay', '.4')
ui.element('file-document')
back()
ui.element('file-links:thought')
ui.capture('process-return')
link(1, row='file-links:thought')
title('sample.swift')
ui.element('file-source')
nested = geometry('process-code-target')
assert nested['line'] == 120 and nested['highlighted'], nested
assert nested['top'] < nested['targetY'] < nested['bottom'] - nested['targetHeight'], nested
ui.capture('process-code-target')
back()
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=catalog.text('process.title')), '--post-delay', '.5')
ui.element('file-links:answer')
# Switching between Diff and source preserves source rendering and target-line reveal.
ui.axe('tap', '--label', 'Diff Viewer', '--post-delay', '.5')
ui.element('diff-render-ms')
ui.capture('shared-diff')
back()
ui.element('file-links:answer')
link(1)
title('sample.swift')
ui.element('file-source')
ui.wait(lambda _: geometry('source-after-diff').get('line') == 120, 'Source mode was not restored after diff')
restored = geometry('source-after-diff')
assert restored['highlighted'] and restored['top'] < restored['targetY'] < restored['bottom'] - restored['targetHeight'], restored
ui.capture('source-after-diff')
back()
if os.environ.get('LODY_VERIFY_FILE_SOURCE_ONLY') == '1':
    print('PASS: source preview scrolls in both axes to EOF, highlights and reveals the target line, reopens after swipe dismissal, and works in browser/chat/process hosts')
    sys.exit(0)

for index, name in [(2, 'photo.png'), (3, 'document.pdf')]:
    link(index)
    quicklook_loaded()
    items = ui.state()
    assert not any((i.get('AXUniqueId') or '') == 'chat-image-preview' for i in items), 'Inline file links must not open ChatImagePreview'
    assert not any(i.get('AXLabel') == catalog.text('native.chat.image.closePreview') for i in items), 'Inline file links must not use the image lightbox'
    extension = name.split('.')[-1]
    ui.capture('quicklook-loaded-' + extension)
    # AX bounds may be smaller than UIKit's expanded bar-button touch area.
    close = ui.element('file-quicklook-close')['frame']
    ui.axe('tap', '-x', str(close['x'] + close['width'] / 2 - 21),
           '-y', str(close['y'] + close['height'] / 2), '--post-delay', '.5')
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'QLPreviewControllerView' for i in items), 'Close must dismiss Quick Look')
    ui.element('file-links:answer')
    ui.capture('quicklook-close-return-' + extension)
    link(index)
    quicklook_loaded()
    ui.capture('quicklook-reopened-' + extension)
    dismiss_quicklook()
    ui.element('file-links:answer')
    assert not any((i.get('AXUniqueId') or '') == 'QLPreviewControllerView' for i in ui.state()), 'Pull-down must dismiss presented Quick Look'
    ui.capture('quicklook-drag-return-' + extension)
link(4)
ui.wait(lambda items: any(catalog.text('files.error.notFound') in str(i.get('AXLabel') or '') for i in items), 'Missing-file error was swallowed')
ui.capture('missing-file')
ui.axe('tap', '--label', catalog.text('common.retry'), '--post-delay', '.2')
ui.element('file-loading', timeout=2)
ui.wait(lambda items: any(catalog.text('files.error.notFound') in str(i.get('AXLabel') or '') for i in items), 'Retry lost the missing-file error')
back()
# A machine RPC rejection must not claim that the computer is offline.
link(5)
ui.wait(lambda items: any(catalog.text('files.error.read') in str(i.get('AXLabel') or '') for i in items), 'RPC rejection must show a read failure')
assert not any(catalog.text('files.error.offline') in str(i.get('AXLabel') or '') for i in ui.state()), 'RPC rejection was mislabeled as offline'
ui.capture('rpc-read-failure')
back()
# A late image response must not open Quick Look after leaving its loading page.
link(2)
ui.element('file-loading', timeout=2)
ui.axe('tap', '--id', 'file-quicklook-close', '--post-delay', '.5')
time.sleep(5.5)
ui.element('file-links:answer')
assert not any(i.get('AXUniqueId') == 'QLPreviewControllerView' for i in ui.state()), 'Cancelled loading must not reopen Quick Look'
ui.capture('cancelled-loading')
print('PASS: files push before slow reads, deselect on return, and ignore late cancelled reads; Markdown/source, relative links, presented Quick Look, retry and process-sheet navigation work')
