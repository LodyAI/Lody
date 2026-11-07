"""Long-text landing and mixed attachment transitions through chat and sheet hosts."""
import json
import shutil
import subprocess
from pathlib import Path
import sys
from driver import UI
import catalog
from send_motion import ThrowTrace

ui = UI(*sys.argv[1:])
trace = ThrowTrace(ui)
attachment_before = set(trace.folder.glob("lody-attachment-*.json"))
source = 'create-session-input' if any(i.get('AXUniqueId') == 'create-session-input' for i in ui.state()) else 'session-input'
remove_label = catalog.text('native.chat.attachment.remove', name='fixture.txt')
if not any(item.get('AXLabel') == remove_label for item in ui.state()):
    ui.paste_file(source)
    remove_label = catalog.text('native.chat.attachment.remove', name='clipboard-fixture.txt')
ui.capture('attachment-before-remove')
ui.axe('tap', '--label', remove_label, '--post-delay', '.5')
assert not any(item.get('AXLabel') == remove_label for item in ui.state())
ui.capture('attachment-after-remove')
names = ['01-notes.txt', '02-landscape.png', '03-report.txt', '04-portrait.png', '05-summary.txt']
ui._paste_provider(source, 'mixed-pasteboard.swift', names)
body = '\n'.join(f'Line {i:02d} This message keeps all text.' for i in range(1, 13))
ui.axe('tap', '--id', source)
# This case verifies landing and attachment ownership, not HID key synthesis.
# Paste through the real edit menu so Shift/autocorrection cannot alter the fixture.
subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input=body, text=True, check=True, timeout=20)
field = ui.element(source)['frame']
ui.axe('touch', '-x', str(field['x'] + field['width'] / 2), '-y', str(field['y'] + field['height'] / 2), '--down', '--up', '--delay', '.8')
paste = ui.wait(lambda items: max(
    (item for item in items if item.get('AXLabel') == catalog.system('paste')),
    key=lambda item: item['frame']['width'] * item['frame']['height'], default=None,
), 'Paste did not appear for the long-text fixture')['frame']
ui.axe('tap', '-x', str(paste['x'] + paste['width'] / 2), '-y', str(paste['y'] + paste['height'] / 2), '--post-delay', '.5')
assert ui.element(source)['AXValue'] == body, 'Long-text fixture did not paste exactly'
assert ui.element('inputView')['frame']['height'] > 200
actual = ui.element(source)['AXValue']
source_frame = ui.element(source)['frame']
assert source_frame['height'] >= 130, 'Fixture did not reach the input height limit'
ui.capture('source-long-mixed')
ui.axe('tap', '--id', 'session-send', '--post-delay', '1')
timer = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').endswith(':duration')), None), 'Destination did not show the local send')
turn = timer['AXUniqueId'].removesuffix(':duration')
assert timer['AXLabel'] == catalog.text('native.chat.transcript.status.confirming'), 'Unacked send must confirm delivery on the duration row'
message_id = turn + ':user-text'
message = ui.element(message_id)
assert message['AXLabel'] == actual, 'Sending truncated message contents'
assert message['AXValue'] == catalog.text('native.chat.message.expand')
assert abs(message['frame']['height'] - 24 - source_frame['height']) < 1.5, 'Bubble landing height differs from source viewport'
# With the software keyboard open, the attachment row can be above the
# viewport. Dismiss it through the production list's interactive scroll.
attachments_offscreen = not any(item.get('AXUniqueId') == turn + ':attachments-toggle' for item in ui.state())
if attachments_offscreen:
    ui.capture('landed-keyboard')
    ui.axe('swipe', '--start-x', '200', '--start-y', '250', '--end-x', '200', '--end-y', '700', '--duration', '.5', '--post-delay', '.6')
ui.element(turn + ':attachments-toggle')
visible_count = sum((item.get('AXUniqueId') or '').startswith(turn + ':attachment:') for item in ui.state())
hidden_count = str(len(names) - visible_count)
ui.capture('landed-collapsed')

# Expand only the text, preserving its top and keeping attachments folded.
y = ui.element(message_id)['frame']['y']
ui.axe('tap', '--id', message_id, '--post-delay', '.5')
expanded = ui.element(message_id)
assert expanded['frame']['height'] > message['frame']['height'] + 100
assert abs(expanded['frame']['y'] - y) < 1.5, 'Expanding jumped the reading position'
assert ui.element(turn + ':attachments-toggle')['AXLabel'] == catalog.text('native.chat.attachments.expand', count=hidden_count)
ui.capture('text-expanded')
# The message keeps one VoiceOver identity. The visible footer is the touch target.
for _ in range(5):
    item = ui.element(message_id)
    bottom = item['frame']['y'] + item['frame']['height'] - 12
    if bottom < ui.element('session-input')['frame']['y']:
        break
    ui.axe('swipe', '--start-x', '200', '--start-y', '600', '--end-x', '200', '--end-y', '300', '--duration', '.4', '--post-delay', '.3')
frame = ui.element(message_id)['frame']
ui.axe('tap', '-x', str(frame['x'] + frame['width'] * .75), '-y', str(frame['y'] + frame['height'] - 34), '--post-delay', '.5')
assert abs(ui.element(message_id)['frame']['height'] - message['frame']['height']) < 1.5
ui.capture('text-collapsed')

# Overflow reveals all original attachments in selection order, independently of text.
ui.axe('tap', '--id', turn + ':attachments-toggle', '--post-delay', '.5')
items = [item for item in ui.state() if (item.get('AXUniqueId') or '').startswith(turn + ':attachment:')]
assert len(items) == 5, 'Overflow did not expose all attachments'
ordered = sorted(items, key=lambda item: (round(item['frame']['y']), item['frame']['x']))
assert all(name in (item.get('AXLabel') or '') for name, item in zip(names, ordered)), 'Mixed selection order changed'
assert ui.element(message_id)['AXValue'] == catalog.text('native.chat.message.expand')
ui.capture('attachments-expanded')
image = next(item for item in items if '02-landscape.png' in (item.get('AXLabel') or ''))
ui.axe('tap', '--id', image['AXUniqueId'])
close_preview = catalog.text('native.chat.image.closePreview')
ui.wait(lambda items: any(item.get('AXLabel') == close_preview for item in items), 'Image tap did not open preview')
ui.capture('image-preview')
screen = next(item for item in ui.state() if item.get('frame') and item['frame'].get('height', 0) > 500)
width, height = screen['frame']['width'], screen['frame']['height']
page_one = catalog.text('native.chat.image.page', current=1, total=2)
page_two = catalog.text('native.chat.image.page', current=2, total=2)
assert any(item.get('AXLabel') == page_one for item in ui.state()), 'Mixed attachments must open as a gallery'
ui.axe('swipe', '--start-x', str(width * 0.8), '--start-y', str(height * 0.5),
       '--end-x', str(width * 0.2), '--end-y', str(height * 0.5), '--duration', '0.4', '--post-delay', '0.8')
assert any(item.get('AXLabel') == page_two for item in ui.state()), 'Gallery must swipe to the other photo'
ui.axe('drag', '--start-x', str(width / 2), '--start-y', str(height * 0.45),
       '--end-x', str(width / 2), '--end-y', str(height * 0.85),
       '--duration', '0.6', '--post-delay', '2')
assert not any(item.get('AXLabel') == close_preview for item in ui.state()), (
    'Local attachment preview must dismiss with the zoom gesture'
)
ui.axe('tap', '--id', turn + ':attachments-toggle', '--post-delay', '.5')
ui.capture('attachments-collapsed')

# Server takeover keeps the same compact geometry even with authoritative image dimensions.
ui.axe('tap', '--id', 'send-connect')
if source == 'create-session-input':
    ui.wait(lambda items: any((item.get('AXLabel') or '').endswith(' · creating') for item in items), 'Creation did not start')
    ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any((item.get('AXLabel') or '').endswith(' · sending') for item in items), 'Send did not start')
uploading = [item for item in ui.state() if (item.get('AXUniqueId') or '').startswith(turn + ':attachment:')]
assert uploading and all(item.get('AXValue') == catalog.text('send.status.uploading') for item in uploading), 'Attachment tiles must expose their upload state'
assert not any(item.get('AXUniqueId') == turn + ':pending' for item in ui.state()), 'Upload must not create a separate status cell'
ui.capture('attachment-uploading')
for step, percent in enumerate([25, 65]):
    ui.axe('tap', '--id', 'send-upload-progress')
    expected = catalog.text('native.chat.attachment.uploadProgress', percent=str(percent))
    ui.wait(lambda items: any((item.get('AXUniqueId') or '').startswith(turn + ':attachment:') and item.get('AXValue') == expected for item in items), 'Real tile did not receive injected upload progress')
    tiles = [item for item in ui.state() if (item.get('AXUniqueId') or '').startswith(turn + ':attachment:')]
    assert [item.get('AXValue') for item in sorted(tiles, key=lambda item: item['frame']['x'])] == [catalog.text('native.chat.attachment.uploadProgress', percent=str(percent + i)) for i in range(len(tiles))], 'Progress must be per attachment'
    assert not any(item.get('AXUniqueId') == turn + ':pending' for item in ui.state())
    ui.capture(f'attachment-progress-{percent}')
ui.axe('tap', '--id', 'send-upload-progress')
ui.wait(lambda items: any(item.get('AXValue') == catalog.text('native.chat.attachment.verifying') for item in items), 'Upload must wait for server verification')
first_file = next(item for item in ui.state() if (item.get('AXUniqueId') or '').startswith(turn + ':attachment:') and '01-notes.txt' in (item.get('AXLabel') or ''))
assert not first_file.get('AXValue'), 'One finished attachment must clear independently while another is still verifying'
ui.capture('attachment-verifying')
ui.axe('tap', '--id', 'send-upload-progress')
ui.wait(lambda items: all(not item.get('AXValue') for item in items if (item.get('AXUniqueId') or '').startswith(turn + ':attachment:')), 'Completed uploads must clear their indicators before message acknowledgement')
ui.capture('attachments-uploaded')
ui.axe('tap', '--id', 'send-complete')
ui.wait(lambda items: any((item.get('AXLabel') or '').endswith(' · accepted') for item in items), 'Receipt missing')
ui.axe('tap', '--id', 'send-reply')
ui.wait(lambda items: any((item.get('AXLabel') or '').endswith(' · idle') for item in items), 'History did not reconcile')
assert all(not item.get('AXValue') for item in ui.state() if (item.get('AXUniqueId') or '').startswith(turn + ':attachment:')), 'History takeover must clear tile loading'
assert abs(ui.element(message_id)['frame']['height'] - message['frame']['height']) < 1.5
ui.capture('history-reconciled')

# An attachment-only send has a real file card and no empty text bubble.
ui.paste_file('session-input')
ui.capture('file-only-source')
ui.axe('tap', '--id', 'session-send')
status = ui.wait(lambda items: next((item for item in items if (item.get('AXUniqueId') or '').endswith(':duration') and not (item.get('AXUniqueId') or '').startswith(turn)), None), 'Attachment-only send missing')
file_turn = status['AXUniqueId'].removesuffix(':duration')
assert status['AXLabel'] == catalog.text('native.chat.transcript.status.confirming'), 'Unacked attachment-only send must confirm delivery on the duration row'
file_items = [item for item in ui.state() if (item.get('AXUniqueId') or '').startswith(file_turn + ':attachment:')]
assert len(file_items) == 1 and 'clipboard-fixture.txt' in file_items[0]['AXLabel']
assert file_items[0].get('AXValue') == catalog.text('send.status.uploading'), 'File-only tile must show loading'
assert not any(item.get('AXUniqueId') == file_turn + ':pending' for item in ui.state()), 'File-only upload added a status cell'
assert not any(item.get('AXUniqueId') == file_turn + ':user-text' for item in ui.state()), 'Attachment-only send added an empty bubble'
ui.capture('file-only-landed')

# Verify the actual flight's geometry rather than screenshots alone.
trace.verify(1)
files = list(ui.output.glob('lody-throw-*.json'))
assert files, 'Missing flight geometry'
for file in files:
    data = json.loads(file.read_text())
    assert abs(data['source'][3] - data['destination'][3]) < 1.5, 'Flight changed the long-text viewport height'
    assert data['destination'][3] <= 140.5
print('PASS: same-height long-text landing, independent expansion, ordered mixed attachments, image preview and native transition continuity')

attachment_paths = set(trace.folder.glob('lody-attachment-*.json')) - attachment_before
# A reader drag cancels offscreen pending copies instead of starting a flight
# against the moving viewport. The later file-only send must still animate.
assert len(attachment_paths) >= (1 if attachments_offscreen else 2), 'Missing visible attachment flight'
attachment_reports = []
for path in sorted(attachment_paths):
    shutil.copy2(path, ui.output / path.name)
    data = json.loads(path.read_text())
    viewport = data['samples'][0]['listFrame']
    x, y, width, height = data['destination']
    assert x >= viewport[0] - 1.5 and y >= viewport[1] - 1.5, 'Attachment flew to a clipped destination'
    assert x + width <= viewport[0] + viewport[2] + 1.5 and y + height <= viewport[1] + viewport[3] + 1.5, 'Attachment landed outside the list viewport'
    if data.get('transition') == 'reveal':
        frames = [sample for sample in data['samples'] if sample['event'] == 'frame' and sample['t'] >= sample['budget']]
        assert len(frames) >= 4 and not data['cancelled'], 'Missing late attachment reveal samples'
        assert all(not sample['targetHidden'] for sample in frames), 'Late attachment stayed hidden'
        assert frames[0]['opacity'] < .75 and frames[-1]['opacity'] >= .99, 'Late attachment did not fade into view'
        error = max(max(abs(a - b) for a, b in zip(sample['frame'], data['destination'])) for sample in frames)
        assert error <= 1.5, f'Late attachment moved {error}pt during reveal'
        attachment_reports.append({'file': path.name, 'transition': 'reveal', 'landingErrorPt': error, 'frames': len(frames)})
        continue
    flight = [sample for sample in data['samples'] if not sample['adopted']]
    landed = [sample for sample in data['samples'] if sample['adopted']]
    assert flight and landed and not data['cancelled'], 'Attachment flight did not complete'
    assert all(sample['targetHidden'] for sample in flight), 'Destination flashed while its attachment was flying'
    assert all(not sample['targetHidden'] for sample in landed), 'Landed attachment stayed hidden'
    error = max(max(abs(a - b) for a, b in zip(sample['modelFrame'], data['destination'])) for sample in landed)
    assert error <= 1.5, f'Attachment jumped {error}pt when it landed'
    attachment_reports.append({'file': path.name, 'landingErrorPt': error, 'frames': len(flight)})
(ui.output / 'attachment-summary.json').write_text(json.dumps(attachment_reports, indent=2))
print('PASS: file/image/overflow handoffs either land continuously or reveal the late destination without a stale flight')
