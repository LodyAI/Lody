"""Explicit plain paste keeps a long draft inline in both production hosts."""
import subprocess
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
identifier = next(item['AXUniqueId'] for item in ui.state()
                  if item.get('AXUniqueId') in ['session-input', 'create-session-input'])
body = '\n'.join(f'Plain text line {index}' for index in range(16))
subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input=body, text=True, check=True, timeout=10)
ui.axe('tap', '--id', identifier, '--post-delay', '.4')
frame = ui.element(identifier)['frame']
ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2),
       '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
label = catalog.text('native.chat.composer.pastePlainText')
action = ui.wait(lambda items: max((item for item in items if item.get('AXLabel') == label),
                                  key=lambda item: item['frame']['width'] * item['frame']['height'], default=None),
                 'Missing plain paste action')['frame']
ui.capture('plain-paste-menu')
ui.axe('tap', '-x', str(action['x'] + action['width'] / 2),
       '-y', str(action['y'] + action['height'] / 2), '--post-delay', '.5')
if any(item.get('AXLabel') == 'Allow Paste' for item in ui.state()):
    ui.axe('tap', '--label', 'Allow Paste', '--post-delay', '.5')
assert body in ui.element(identifier).get('AXValue', ''), 'Plain paste did not retain the full inline text'
assert not any(item.get('AXLabel') == catalog.text('native.chat.attachment.preview', name='Text.txt')
               for item in ui.state()), 'Plain paste created an attachment'
ui.capture('plain-paste-inline')
print('PASS: plain text menu inserts long text inline')
