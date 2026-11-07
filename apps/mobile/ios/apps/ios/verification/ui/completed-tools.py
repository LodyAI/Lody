"""Open Native session with --ui-verify --ui-verify-process-tools first."""
import sys
from driver import UI

ui = UI(*sys.argv[1:])
ui.element('session-preview-probe')
assert not any(i.get('AXUniqueId') == 'preview-answer:process' for i in ui.state())
ui.capture('collapsed')
ui.axe('tap', '--id', 'preview-user:duration', '--post-delay', '.5')
intro = ui.element('preview-answer:intro')
summary = ui.element('preview-answer:process')
answer = ui.element('preview-answer:answer')
assert intro['frame']['y'] < summary['frame']['y'] < answer['frame']['y']
assert 'git branch' not in (summary.get('AXLabel') or '')
ui.capture('expanded')
ui.axe('tap', '--id', 'preview-answer:process', '--post-delay', '.8')
command = ui.element('preview-answer:command')
assert 'git branch -m session/example' in command['AXLabel']
assert command['frame']['height'] <= 44, 'Long commands must stay on a single compact row'
assert not any(i.get('AXUniqueId') == 'preview-answer:intro' for i in ui.state() if i['frame']['y'] >= command['frame']['y'])
ui.capture('commands')
print('PASS: completed tools stay in order and reveal single-line commands')
