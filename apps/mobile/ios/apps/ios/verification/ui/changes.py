"""Finished replies keep tappable file cards, never a running system warning."""
import subprocess
import sys
import time
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
ui.axe('tap', '--label', 'Fixtures')
ui.axe('tap', '--label', 'Diff Fixture')
paths = ['docs/superpowers/.diff-check.md', 'src/very-long-directory-name/nested/components/another-long-file-name.ts']
header = ui.element('diff-preview:changes')
assert header['AXLabel'] == catalog.text(
    'native.chat.file.diffStats',
    text=catalog.plural('native.chat.transcript.fileCount', 2), add=2, **{'del': 2}
)
assert 44 <= header['frame']['height'] < 45, header['frame']['height']
for path in paths:
    card = ui.element('diff-preview:changes:' + path)
    assert card['AXLabel'] == catalog.text('native.chat.file.diffStats', text=path, add=1, **{'del': 1})
    height = card['frame']['height']
    assert 40 <= height < 41, f'{path} height {height}'
answer = ui.element('diff-preview:answer')
first_id = 'diff-preview:changes:' + paths[0]
second_id = 'diff-preview:changes:' + paths[1]

def group_settled(items):
    header_item = next((i for i in items if i.get('AXUniqueId') == 'diff-preview:changes'), None)
    first_item = next((i for i in items if i.get('AXUniqueId') == first_id), None)
    second_item = next((i for i in items if i.get('AXUniqueId') == second_id), None)
    if not header_item or not first_item or not second_item:
        return None
    header_frame = header_item['frame']
    first_frame = first_item['frame']
    second_frame = second_item['frame']
    header_bottom = header_frame['y'] + header_frame['height']
    first_bottom = first_frame['y'] + first_frame['height']
    if first_frame['y'] < answer['frame']['y'] + answer['frame']['height']:
        return None
    if abs(first_frame['y'] - header_bottom) > 2:
        return None
    if abs(second_frame['y'] - first_bottom) > 2:
        return None
    if any(abs(frame['x'] - header_frame['x']) > 1 or abs(frame['width'] - header_frame['width']) > 1
           for frame in (first_frame, second_frame)):
        return None
    return header_item, first_item, second_item

header, first, second = ui.wait(group_settled, 'File group header did not settle above the first file')
items = ui.state()
assert not any((i.get('AXUniqueId') or '').startswith(('diff-warning:', 'diff-cached-warning:')) for i in items)
assert not any(catalog.text('native.chat.transcript.status.running') in (i.get('AXLabel') or '') for i in items)
def probe(items):
    item = next((i for i in items if i.get('AXUniqueId') == 'diff-webview-probe'), None)
    if not item:
        return None
    parts = (item.get('AXLabel') or '').split()
    if len(parts) < 2:
        return None
    try:
        return parts[0], int(parts[1])
    except ValueError:
        return None

ui.capture('cards')
probes = []
times = []
for index, path in enumerate(paths):
    ui.axe('tap', '--id', 'diff-preview:changes:' + path)
    ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == path.split('/')[-1] for i in items), 'Wrong file opened')
    if index == 0:
        subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input='clipboard sentinel', text=True, check=True, timeout=10)
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('common.more') for i in items), 'Diff more action was missing')
        ui.axe('tap', '--label', catalog.text('common.more'), '--element-type', 'Button', '--post-delay', '.4')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.copyFileName') for i in items), 'Copy filename action was missing')
        ui.capture('diff-menu')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.copyPath') for i in items), 'Copy path action was missing')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.copyContents') for i in items), 'Copy contents action was missing')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.copyPatch') for i in items), 'Copy patch action was missing')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.previewFile') for i in items), 'Preview file action was missing')
        ui.axe('tap', '--label', catalog.text('diff.action.copyFileName'), '--post-delay', '.4')
        copied = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10)
        assert copied == path.split('/')[-1], repr(copied)
        ui.wait(lambda items: any(i.get('AXUniqueId') == 'lody.toast' and i.get('AXLabel') == catalog.text('diff.toast.copied') for i in items), 'Copy toast was missing')
        ui.capture('copied-toast')
        ui.axe('tap', '--label', catalog.text('common.more'), '--element-type', 'Button', '--post-delay', '.4')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.copyPath') for i in items), 'Copy path action did not reopen')
        ui.axe('tap', '--label', catalog.text('diff.action.copyPath'), '--post-delay', '.4')
        copied_path = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10)
        assert copied_path == path, repr(copied_path)
        ui.wait(lambda items: any(i.get('AXUniqueId') == 'lody.toast' and i.get('AXLabel') == catalog.text('diff.toast.copied') for i in items), 'Copy path toast was missing')
    ui.wait(lambda items: any(i.get('AXLabel') == 'Unified' for i in items), 'Diff response did not load')
    current = ui.wait(lambda items: probe(items), 'Shared Diff WebView probe was missing')
    probes.append(current)
    rendered = ui.wait(
        lambda items: next(
            (
                i
                for i in items
                if i.get('AXUniqueId') == 'diff-render-ms'
                and (i.get('AXLabel') or '').isdigit()
            ),
            None,
        ),
        'Diff render timing probe was missing',
    )
    times.append(int(rendered['AXLabel']))
    if index == 0:
        ui.axe('tap', '--label', catalog.text('common.more'), '--element-type', 'Button', '--post-delay', '.4')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.copyContents') for i in items), 'Copy contents action did not reopen')
        ui.axe('tap', '--label', catalog.text('diff.action.copyContents'), '--post-delay', '.4')
        copied_contents = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10)
        assert copied_contents == 'a\nhello\nc\n', repr(copied_contents)
        ui.wait(lambda items: any(i.get('AXUniqueId') == 'lody.toast' and i.get('AXLabel') == catalog.text('diff.toast.copied') for i in items), 'Copy contents toast was missing')
        ui.axe('tap', '--label', catalog.text('common.more'), '--element-type', 'Button', '--post-delay', '.4')
        ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('diff.action.copyPatch') for i in items), 'Copy patch action did not reopen')
        ui.axe('tap', '--label', catalog.text('diff.action.copyPatch'), '--post-delay', '.4')
        copied_patch = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10)
        assert f'--- a/{path}' in copied_patch, repr(copied_patch)
        assert f'+++ b/{path}' in copied_patch, repr(copied_patch)
        assert '-b\n+hello\n' in copied_patch, repr(copied_patch)
        ui.wait(lambda items: any(i.get('AXUniqueId') == 'lody.toast' and i.get('AXLabel') == catalog.text('diff.toast.copied') for i in items), 'Copy patch toast was missing')
        ui.capture('copied-patch')
    time.sleep(1)
    ui.capture('diff-' + str(index))
    ui.axe('tap', '--label', 'Split')
    ui.wait(lambda items: any(i.get('AXLabel') == 'Split' and i.get('AXValue') == 1 for i in items), 'Split mode was not selected')
    time.sleep(.5)
    ui.capture('split-' + str(index))
    ui.axe('tap', '--label', 'Unified')
    if index == 0:
        # Release an edge swipe before halfway: the native return must cancel.
        ui.axe('drag', '--start-x', '2', '--start-y', '400', '--end-x', '70', '--end-y', '400', '--duration', '1', '--post-delay', '.8')
        ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == path.split('/')[-1] for i in items), 'Cancelled return dismissed the diff')
        ui.capture('cancelled-return')
    ui.axe('tap', '--id', 'BackButton')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'diff-preview:changes:' + path and 'selected' not in str(i.get('traits') or []).lower() for i in items), 'File row stayed selected after return')
assert probes[0][0] == probes[1][0], f'reused instance changed {probes}'
assert probes[1][1] <= probes[0][1], f'second open reloaded the DOM bundle {probes}'
ui.capture('returned')
print('Grouped file block, counts, direct diff navigation and completed state passed')
print('diff-reuse instanceId=%s navigationCount=%s,%s renderMs=%s' % (probes[0][0], probes[0][1], probes[1][1], times))
