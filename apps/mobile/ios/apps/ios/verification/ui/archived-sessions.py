"""Native archived sessions: archived-only tree rows, unarchive, deletion cancel/failure/retry, and rename through the shared row menu."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
delete = catalog.text('session.action.delete')


def spoken(item):
    return ' '.join([str(item.get(key) or '') for key in ('AXLabel', 'AXValue')] + [spoken(child) for child in item.get('children') or []])


def writes():
    return ui.element('archived-preview-writes').get('AXValue') or ''


def tap_label(label):
    ui.wait(lambda items: any(i.get('AXLabel') == label for i in items), f'Missing {label}')
    ui.axe('tap', '--label', label, '--post-delay', '.5')


def menu(identifier, action):
    frame = ui.element(identifier)['frame']
    ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
    tap_label(action)


def gone(identifier, message):
    ui.wait(lambda items: not any(i.get('AXUniqueId') == identifier for i in items), message)


release = ui.element('archived-release')
assert 'Prepare release notes' in spoken(release) and catalog.text('inbox.badge.archived') in spoken(release), spoken(release)
assert 'release/2.4' in spoken(release), spoken(release)
ui.element('archived-chat')
assert not any(i.get('AXUniqueId') == 'active-session' for i in ui.state()), 'Active sessions must stay out of the archive'
ui.capture('archived-list')

menu('archived-chat', catalog.text('session.action.unarchive'))
ui.wait(lambda _: 'archive:archived-chat:false' in writes(), 'Unarchive did not write')
gone('archived-chat', 'Unarchived session stayed in the archive')

menu('archived-release', delete)
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('session.delete.title') for i in items), 'Missing confirmation')
ui.capture('delete-confirmation')
tap_label(catalog.text('common.cancel'))
ui.element('archived-release')
assert 'delete' not in writes(), 'Cancel must not delete'

menu('archived-release', delete)
tap_label(delete)
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('session.delete.failed') for i in items), 'Missing failure feedback')
assert 'delete-failed:archived-release' in writes()
ui.element('archived-release')
ui.capture('delete-failed')

menu('archived-release', delete)
tap_label(delete)
gone('archived-release', 'Retry did not delete the session')
assert 'delete:archived-release' in writes(), writes()
ui.element('archived-release-check')
ui.capture('deleted')

menu('archived-release-check', catalog.text('session.action.rename'))
ui.wait(lambda items: any(i.get('type') == 'TextField' for i in items), 'Rename prompt has no field')
ui.capture('rename-prompt')
tap_label(catalog.text('common.cancel'))
assert 'rename' not in writes()
print('PASS: archived rows exclude active sessions; unarchive, delete cancel/failure/retry and the rename prompt go through the session service.')
