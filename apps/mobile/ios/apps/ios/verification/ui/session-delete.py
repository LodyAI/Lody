"""Production list/header deletion: cancel, service failure, retry, and return."""
import sys
from driver import UI
import catalog
import pad as pad_layout

ui = UI(sys.argv[1], sys.argv[2])
pad = any(i.get('AXUniqueId') == 'ipad-home' for i in ui.state())
delete = catalog.text('session.action.delete')


def tap_label(label):
    ui.wait(lambda items: any(i.get('AXLabel') == label for i in items), f'Missing {label}')
    ui.axe('tap', '--label', label, '--post-delay', '.5')


def menu(identifier):
    frame = ui.element(identifier)['frame']
    ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
    tap_label(delete)
    ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('session.delete.title') for i in items), 'Missing confirmation')


def toggle_archived():
    tap_label(catalog.text('inbox.settings.section.view'))
    tap_label(catalog.text('home.view.archived'))


if pad:
    pad_layout.show_list(ui)
# Archived chats live behind the Chats view menu's Archived switch.
toggle_archived()
ui.element('ui-search')
menu('ui-search')
ui.capture('archived-confirmation')
tap_label(catalog.text('common.cancel'))
ui.element('ui-search')
menu('ui-search')
tap_label(delete)
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('session.delete.failed') for i in items), 'Missing failure feedback')
ui.element('ui-search')
ui.capture('failed-keeps-session')
menu('ui-search')
tap_label(delete)
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('home.archived.empty') for i in items), 'Archived deletion did not empty list')
ui.capture('archived-deleted')
toggle_archived()

ui.axe('tap', '--id', 'ui-design', '--post-delay', '.8')
tap_label(catalog.text('common.more'))
tap_label(delete)
ui.capture('chat-confirmation')
tap_label(catalog.text('common.cancel'))
ui.element('session-input')
tap_label(catalog.text('common.more'))
tap_label(delete)
tap_label(delete)
if pad:
    ui.element('ipad-detail-placeholder')
    ui.wait(lambda items: not any(i.get('AXLabel') == catalog.text('common.more') for i in items), 'Deleted conversation left its toolbar behind')
else:
    ui.element('ui-pinned')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'ui-design' for i in items), 'Deleted session still listed')
ui.capture('returned-after-delete')

if pad:
    pad_layout.show_list(ui)
    ui.axe('tap', '--id', 'ui-pinned', '--post-delay', '.7')
    ui.element('session-input')
    pad_layout.show_list(ui)
menu('ui-pinned')
ui.capture('list-confirmation')
tap_label(delete)
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'ui-pinned' for i in items), 'List deletion did not remove session')
if pad:
    ui.element('ipad-detail-placeholder')
    ui.wait(lambda items: not any(i.get('AXLabel') == catalog.text('common.more') for i in items), 'Sidebar deletion left stale conversation controls')
ui.capture('list-deleted')
print('Cancel preserves sessions; failure preserves the archived row; retry removes it; chat deletion returns or clears iPad detail; list deletion removes the row.')
