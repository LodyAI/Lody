"""Production folder browser: machine choice, read failure, pagination, typed paths and unconfirmed registration."""
import json
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def spoken(item):
    return ' '.join(str(item.get(key) or '') for key in ('AXLabel', 'AXValue')) + ' ' + ' '.join(spoken(child) for child in item.get('children') or [])


def tap(identifier):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.5')


def has_text(text):
    ui.wait(lambda items: any(text in spoken(item) for item in items), f'Missing {text}')


def back():
    frame = next(item['frame'] for item in reversed(ui.state()) if item.get('AXUniqueId') == 'BackButton')
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.6')


def use_button():
    label = catalog.text('directory.accessibility.use')
    return ui.wait(lambda items: next((item for item in items if item.get('AXLabel') == label and item.get('type') == 'Button' and item.get('enabled')), None), 'Use folder is not ready')


def cancel_button():
    return next((item for item in ui.state() if item.get('AXLabel') == catalog.text('common.cancel') and item.get('type') == 'Button'), None)


def entries():
    return [item for item in ui.state() if str(item.get('AXUniqueId', '')).startswith('entry:')]


assert 'Studio Mac' in spoken(ui.element('studio'))
assert 'Travel Mac' in spoken(ui.element('travel'))
assert cancel_button(), 'Choose Folder has no Cancel'
ui.capture('machines')

tap('travel')
has_text(catalog.text('directory.error.read'))
assert not cancel_button(), 'Cancel replaced Back inside a machine'
ui.element('retry')
assert not any(item.get('AXLabel') == catalog.text('directory.accessibility.use') and item.get('enabled') for item in ui.state()), 'Use folder enabled without a listing'
ui.capture('read-failure')
tap('retry')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'path' and '/Users/travel' in spoken(item) for item in items), 'Retry did not read the folder')
assert not entries() and not any(item.get('AXUniqueId') == 'retry' for item in ui.state())
ui.capture('empty-folder')
back()

tap('studio')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'entry:2' for item in items), 'Folder listing did not load')
assert catalog.text('directory.entry.noAccess') in spoken(ui.element('entry:2'))
ui.capture('listing')
tap('more')
ui.wait(lambda items: any('Music' in spoken(item) for item in items if str(item.get('AXUniqueId', '')).startswith('entry:')), 'Next page did not load')
names = [spoken(item) for item in entries()]
assert sum('Documents' in name for name in names) == 1, f'Pagination duplicated a folder: {names}'
assert not any(item.get('AXUniqueId') == 'more' for item in ui.state()), 'Load More stayed after the last page'
ui.capture('paged')

tap('entry:0')
ui.wait(lambda items: any('lody-ios' in spoken(item) for item in items), 'Projects folder did not open')
ui.axe('tap', '--label', catalog.text('directory.accessibility.use'), '--post-delay', '.5')
has_text('Selected Projects /Users/demo/Projects')
ui.element('studio')
ui.capture('selected')

tap('studio')
ui.element('entry:0')
tap('path')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('directory.prompt.title') for item in items), 'Path prompt did not open')
ui.capture('path-prompt')
ui.axe('type', '/Projects/website')
ui.axe('tap', '--label', catalog.text('common.open'), '--post-delay', '.8')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'path' and '/Users/demo/Projects/website' in spoken(item) for item in items), 'Typed path did not open')
use_button()
ui.axe('tap', '--label', catalog.text('directory.accessibility.use'), '--post-delay', '.5')
has_text(catalog.text('directory.error.registerUnknown'))
ui.capture('register-unknown')
use_button()
ui.axe('tap', '--label', catalog.text('directory.accessibility.use'), '--post-delay', '.5')
has_text('Selected website /Users/demo/Projects/website')
ui.capture('registered')
ui.element('studio')
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.8')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'studio' for item in items), 'Cancel did not close Choose Folder')
print(json.dumps({'readFailureRetry': True, 'paginationDeduplicated': True, 'typedPath': True, 'unconfirmedRegistrationRetry': True, 'cancel': True}))
