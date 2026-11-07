"""Sent references retain their short labels and open the production file preview."""
import sys
from driver import UI
ui = UI(*sys.argv[1:])

def title(name):
    ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == name for i in items), 'Wrong file opened: ' + name)

def back():
    ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')

ui.axe('tap', '--label', 'User Mentions', '--post-delay', '.6')
mentions = ui.element('user-mentions:user')
assert mentions['custom_actions'] == ['#30', '@docs/report.md', '$review', '@docs/sample.swift']
assert '[Skill Path]' not in mentions['AXLabel'], 'Skill instructions must render as the short reference'
ui.capture('user-mentions')
for line, name, identifier in [(1, 'report.md', 'file-document'), (2, 'SKILL.md', 'file-document'), (3, 'sample.swift', 'file-source')]:
    frame = ui.element('user-mentions:user')['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] - 150), '-y', str(frame['y'] + 34 + line * 25), '--post-delay', '.5')
    title(name)
    ui.element(identifier)
    ui.capture('user-mention-' + name)
    back()
    ui.element('user-mentions:user')
ui.capture('user-mentions-return')
ui.axe('tap', '--label', 'User Mentions', '--post-delay', '.6')
ui.element('file-links:answer')
print('PASS: sent file/skill nodes open production previews and return; GitHub reference has a native link action')
