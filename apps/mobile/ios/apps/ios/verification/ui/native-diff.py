"""Native file diff: header actions, copies, toolbar stats, unified/split, cancelled return and row deselection."""
import subprocess
import sys
import time
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
paths = ['docs/superpowers/.diff-check.md', 'src/very-long-directory-name/nested/components/another-long-file-name.ts']

def pasted():
    return subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True, timeout=10)

def menu(action):
    ui.axe('tap', '--label', catalog.text('common.more'), '--element-type', 'Button', '--post-delay', '.4')
    ui.wait(lambda items: any(i.get('AXLabel') == catalog.text(action) for i in items), action + ' was missing')
    ui.axe('tap', '--label', catalog.text(action), '--post-delay', '.4')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'lody.toast' and i.get('AXLabel') == catalog.text('diff.toast.copied') for i in items), action + ' toast was missing')

times = []
for index, path in enumerate(paths):
    name = path.split('/')[-1]
    ui.axe('tap', '--id', 'diff-preview:changes:' + path)
    ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == name for i in items), 'Wrong file opened')
    ui.wait(lambda items: any(i.get('AXLabel') == 'Unified' for i in items), 'Diff response did not load')
    stats = ui.element('diff-toolbar-stats')
    assert stats['AXLabel'] == '+1 −1 ' + catalog.text('diff.base.turn'), stats
    rendered = ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == 'diff-render-ms' and (i.get('AXLabel') or '').isdigit()), None), 'Diff render timing probe was missing')
    times.append(int(rendered['AXLabel']))
    if index == 0:
        subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input='clipboard sentinel', text=True, check=True, timeout=10)
        ui.axe('tap', '--label', catalog.text('common.more'), '--element-type', 'Button', '--post-delay', '.4')
        for action in ['diff.action.copyFileName', 'diff.action.copyPath', 'diff.action.copyContents', 'diff.action.copyPatch', 'diff.action.previewFile']:
            ui.wait(lambda items: any(i.get('AXLabel') == catalog.text(action) for i in items), action + ' was missing')
        ui.capture('diff-menu')
        ui.axe('tap', '--label', catalog.text('diff.action.copyFileName'), '--post-delay', '.4')
        assert pasted() == name, pasted()
        ui.capture('copied-toast')
        menu('diff.action.copyPath')
        assert pasted() == path, pasted()
        menu('diff.action.copyContents')
        assert pasted() == 'a\nhello\nc\n', repr(pasted())
        menu('diff.action.copyPatch')
        patch = pasted()
        assert patch == '\n'.join(['=' * 67, f'--- a/{path}', f'+++ b/{path}', '@@ -1,3 +1,3 @@', ' a', '-b', '+hello', ' c', '']), repr(patch)
        ui.capture('copied-patch')
    time.sleep(.5)
    ui.capture('diff-' + str(index))
    ui.axe('tap', '--label', 'Split')
    ui.wait(lambda items: any(i.get('AXLabel') == 'Split' and i.get('AXValue') == 1 for i in items), 'Split mode was not selected')
    time.sleep(.5)
    ui.capture('split-' + str(index))
    ui.axe('tap', '--label', 'Unified')
    if index == 0:
        # Release an edge swipe before halfway: the native return must cancel.
        ui.axe('drag', '--start-x', '2', '--start-y', '400', '--end-x', '70', '--end-y', '400', '--duration', '1', '--post-delay', '.8')
        ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == name for i in items), 'Cancelled return dismissed the diff')
        ui.capture('cancelled-return')
    ui.axe('tap', '--id', 'BackButton')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'diff-preview:changes:' + path and 'selected' not in str(i.get('traits') or []).lower() for i in items), 'File row stayed selected after return')
ui.capture('returned')
print('PASS: native diff header actions, copies, toolbar, split/unified, cancelled return and deselection')
print('renderMs=%s' % times)
