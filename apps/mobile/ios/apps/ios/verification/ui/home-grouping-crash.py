"""Run with --ui-verify --ui-verify-home --ui-verify-sticky-groups.
Switch grouping while scrolled, including transitions that remove visible sections.
"""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
ui.element('home-chat-list')
ui.axe('tap', '--label', catalog.text('inbox.settings.section.view'), '--post-delay', '.2')
ui.axe('tap', '--label', catalog.text('home.scope.team'), '--post-delay', '.4')
assert any((i.get('AXLabel') or '').startswith('Conversation ') for i in ui.state()), 'Fixture must contain visible conversations'
pid = next(i['pid'] for i in ui.state() if i.get('pid'))
for index, grouping in enumerate(['time', 'project', 'status', 'project'] * 2):
    # Bring lower section headers into view before replacing the snapshot.
    ui.axe('drag', '--start-x', '220', '--start-y', '700', '--end-x', '220',
           '--end-y', '180', '--duration', '.6', '--post-delay', '.15')
    ui.axe('tap', '--label', catalog.text('inbox.settings.section.view'), '--post-delay', '.2')
    # Project also appears in the row-detail options; grouping is the upper menu section.
    option = ui.wait(lambda items: min((i for i in items if i.get('AXLabel') == catalog.text('home.grouping.' + grouping)),
                     key=lambda i: i['frame']['y'], default=None), 'Missing grouping option')
    frame = option['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.4')
    ui.element('home-chat-list')
    assert any((i.get('AXLabel') or '').startswith('Conversation ') for i in ui.state()), 'Grouping must retain conversation rows'
    assert any(i.get('pid') == pid for i in ui.state()), 'App must remain alive across grouping updates'
    assert any(i.get('type') == 'Heading' or 'Header' in i.get('traits', []) for i in ui.state()), 'Grouping labels must remain semantic headings'
    if index < 3:
        ui.capture('grouping-' + grouping)
ui.capture('grouping-survived')
print('PASS: scrolled list survived eight grouping changes without restarting')
