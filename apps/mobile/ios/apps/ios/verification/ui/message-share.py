"""Whole-message actions and the actual exported warm-paper JPG, without cloud access."""
import shutil
import re
import subprocess
import sys
from pathlib import Path
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())

def menu():
    ui.axe('tap', '--id', 'paper-reply:meta:actions')
    ui.wait(lambda items: any(i.get('AXLabel') == 'Generate image…' for i in items), 'Message menu missing')

def fixture(name):
    ui.axe('tap', '--label', 'Paper fixtures')
    ui.axe('tap', '--label', name, '--post-delay', '.8')

def close():
    ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title='Image preview'), '--post-delay', '.6')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'paper-reply:meta:actions' for i in items), 'Preview did not release its presentation')
    assert not list((container / 'tmp' / 'lody-message-share').glob('*/Lody.jpg')), 'Temporary export survived dismissal'

def dismiss_share():
    # iOS 26 hosts actions in a remote view, outside AXe's app tree. The native
    # activity view plus framebuffer proves presentation; tap its outside region.
    frame = ui.element('ActivityListView')['frame']
    ui.axe('tap', '-x', '20', '-y', str(max(50, frame['y'] - 40)), '--post-delay', '.6')
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'ActivityListView' for i in items), 'Share popover did not dismiss')

def generate(name):
    menu()
    ui.axe('tap', '--label', 'Generate image…')
    return capture_export(name)

def capture_export(name):
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'message-share-preview' and '1080' in (i.get('AXValue') or '') for i in items), 'JPG never became ready', timeout=45)
    ui.capture(name)
    files = list((container / 'tmp' / 'lody-message-share').glob('*/Lody.jpg'))
    assert len(files) == 1, files
    file = files[0]
    assert file.read_bytes().startswith(b'\xff\xd8'), 'Export is not JPEG'
    dimensions = subprocess.check_output(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(file)], text=True)
    width, height = [int(value) for value in re.findall(r'pixel(?:Width|Height): (\d+)', dimensions)]
    assert width == 1080 and 0 < height <= 12000, (width, height)
    shutil.copy2(file, ui.output / f'{name}-export.jpg')
    return height

button = ui.element('paper-reply:meta:actions')
assert button['frame']['width'] >= 44 and button['frame']['height'] >= 44
expected = ui.element('paper-reply:answer')['AXLabel']
menu()
ui.capture('message-menu')
ui.axe('tap', '--label', 'Copy entire message')
copied = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True)
assert copied == expected and 'PRIVATE-PROCESS' not in copied
(ui.output / 'copied-message.txt').write_text(copied)
ui.wait(lambda items: not any(i.get('AXLabel') == 'Message copied' for i in items), 'Copy toast did not settle')
height = generate('short-paper')
ui.axe('tap', '--label', 'Share image', '--post-delay', '1')
ui.element('ActivityListView')
ui.capture('system-image-share')
dismiss_share()
# Select two non-adjacent blocks in reverse tap order; export must retain source order.
ui.axe('tap', '--label', 'Select content')
ui.element('share-block-0')
ui.capture('block-selection-all')
ui.axe('tap', '--id', 'select-none')
ui.axe('tap', '--id', 'share-block-3')
ui.axe('tap', '--id', 'share-block-1', '--post-delay', '.5')
ui.capture('block-selection-custom')
ui.axe('tap', '--label', 'Done')
capture_export('selected-paper')
ocr = subprocess.check_output(['swift', str(Path(__file__).with_name('paper-ocr.swift')), str(ui.output / 'selected-paper-export.jpg')], text=True, timeout=60)
(ui.output / 'selected-paper-ocr.txt').write_text(ocr)
assert 'Good ideas' in ocr and 'A little space' in ocr, ocr
assert ocr.index('Good ideas') < ocr.index('A little space'), ocr
assert 'A quieter way' not in ocr and 'Keep the useful' not in ocr, ocr
ui.axe('tap', '--label', 'Select content')
assert ui.element('share-block-1').get('AXValue') == 'Selected'
assert ui.element('share-block-0').get('AXValue') == 'Not selected'
ui.axe('tap', '--id', 'select-none')
ui.axe('tap', '--label', 'Done')
ui.wait(lambda items: any('Select at least one block' in (i.get('AXLabel') or '') for i in items), 'Empty selection did not disable export')
assert not list((container / 'tmp' / 'lody-message-share').glob('*/Lody.jpg'))
ui.capture('empty-selection')
ui.axe('tap', '--id', 'message-share-feedback-action')
ui.axe('tap', '--id', 'select-all')
ui.axe('tap', '--label', 'Done')
capture_export('restored-paper')
assert (ui.output / 'short-paper-export.jpg').read_bytes() == (ui.output / 'restored-paper-export.jpg').read_bytes()

close()
fixture('long')
long_height = generate('long-paper')
assert long_height > height * 2
ocr = subprocess.check_output(['swift', str(Path(__file__).with_name('paper-ocr.swift')), str(ui.output / 'long-paper-export.jpg')], text=True, timeout=60)
(ui.output / 'long-paper-ocr.txt').write_text(ocr)
for marker in ['CODE-END', 'PAPER-END', 'Material', 'Appearance', 'Result', 'GPT-6 Astra', 'Lody']:
    assert marker in ocr, f'Export lost rendered content: {marker}\n{ocr}'
assert 'PRIVATE-PROCESS' not in ocr
ui.axe('swipe', '--start-x', '200', '--start-y', '720', '--end-x', '200', '--end-y', '250', '--duration', '.4', '--post-delay', '.5')
ui.capture('long-paper-scrolled')
close()
fixture('no-meta')
ui.element('paper-reply:meta:actions')
generate('no-metadata-paper')
close()
fixture('image')
generate('image-paper')
close()
for name, text in [('large', 'This reply is too large'), ('error', 'Could not generate the complete image')]:
    fixture(name)
    menu()
    ui.axe('tap', '--label', 'Generate image…')
    ui.wait(lambda items: any(text in (i.get('AXLabel') or '') for i in items), 'Missing explicit export failure', timeout=45)
    assert not list((container / 'tmp' / 'lody-message-share').glob('*/Lody.jpg'))
    ui.capture(name)
    if name == 'large':
        assert not any(i.get('AXLabel') == 'Retry' for i in ui.state()), 'An unchanged size limit cannot be retried'
    else:
        ui.axe('tap', '--label', 'Retry')
        ui.wait(lambda items: any(text in (i.get('AXLabel') or '') for i in items), 'Retry did not settle back to an actionable error')
    close()
fixture('short')
menu()
ui.axe('tap', '--label', 'Share text…', '--post-delay', '.8')
ui.element('ActivityListView')
ui.capture('system-text-share')
dismiss_share()
fixture('streaming')
assert not any(i.get('AXUniqueId') == 'paper-reply:meta:actions' for i in ui.state())
print('PASS: whole text, selected blocks in source order, select all/none, paper JPG, long output, missing metadata, image, error/size boundaries, system sharing and dismissal cleanup')
