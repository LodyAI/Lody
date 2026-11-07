"""Zoom from a project navigation button, including cancellation and reopening."""
import sys
import catalog
from driver import UI

ui = UI(*sys.argv[1:])
close = catalog.text('accessibility.closeSheet', title=catalog.text('create.title'))
source = catalog.text('project.newSession.accessibility')

# Open an actual project page through the production Home catalog row.
frame = ui.element('project:ui:empty')['frame']
ui.axe('tap', '-x', str(frame['x'] + 120), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '1')
ui.wait(lambda items: any(i.get('AXLabel') == source for i in items), 'Project creation button missing')
ui.capture('project-source')
ui.element('BackButton')
project_title = ui.wait(lambda items: next((item['AXLabel'] for item in items
    if item.get('type') == 'Heading'), None), 'Project title missing')

for attempt in range(2):
    ui.axe('tap', '--label', source, '--post-delay', '1')
    ui.element('create-session-input')
    ui.capture(f'project-sheet-{attempt}')
    ui.axe('tap', '--label', close, '--post-delay', '1')
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'create-session-input' for i in items), 'Project sheet remained after cancellation')
    ui.element('BackButton')
    ui.wait(lambda items: any(item.get('type') == 'Heading' and item.get('AXLabel') == project_title
                             for item in items), 'Cancellation removed the owning project')
    ui.wait(lambda items: any(item.get('AXLabel') == source for item in items), 'Project creation button disappeared')
    ui.capture(f'project-return-{attempt}')

ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')
ui.element('project:ui:empty')
ui.capture('returned-home')

print('PASS: project toolbar opens and cancels the creation sheet repeatedly without removing its owning page. VISUAL REVIEW REQUIRED: zoom starts and ends at the top navigation button.')
