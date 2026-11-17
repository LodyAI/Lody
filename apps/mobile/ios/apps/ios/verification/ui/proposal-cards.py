"""Offline proposal/file cards through the production transcript and controls."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def text(value):
    ui.wait(lambda items: any(value in str(i.get('AXLabel') or '') for i in items),
            f'Missing rendered text: {value}')


def scene(name):
    ui.open_case('session-preview-cards-' + name)
    ui.wait(lambda items: any(
        i.get('AXUniqueId') == 'session-preview-probe'
        and i.get('AXLabel') == 'Offline card review: cards-' + name
        and 'live' in str(i.get('AXValue') or '').split(',') for i in items),
        f'Card scene did not become live: {name}')


def button(item, action='confirm', enabled=True):
    control = ui.element(f'preview-answer:{item}:{action}')
    assert control.get('enabled') is enabled, control
    return control


def tap(item, action='confirm'):
    ui.axe('tap', '--id', f'preview-answer:{item}:{action}')


def absent_buttons():
    ui.wait(lambda items: not any(
        str(i.get('AXUniqueId') or '').endswith((':confirm', ':dismiss'))
        for i in items), 'Decided proposal still exposes decision buttons')


scene('role-create')
text('Reviewer')
button('create')
button('create', 'dismiss')
ui.capture('role-create')
tap('create')
text(catalog.text('native.chat.proposal.role.saved'))
absent_buttons()
ui.capture('role-create-saved')

scene('role-update')
text('Release reviewer')
text('Reviews changes.')
button('update')
ui.capture('role-update-before-after')
tap('update', 'dismiss')
text(catalog.text('native.chat.proposal.dismissed'))
absent_buttons()

scene('owner-only')
text(catalog.text('native.chat.proposal.role.ownerOnly'))
button('owner', enabled=False)
button('owner', 'dismiss', enabled=False)
ui.capture('owner-only-disabled')

scene('receipts')
text(catalog.text('native.chat.proposal.role.saved'))
text(catalog.text('native.chat.proposal.dismissed'))
absent_buttons()
ui.capture('saved-dismissed')

scene('states')
text(catalog.text('native.chat.proposal.error.failed'))
button('error')
button('pending', enabled=False)
button('pending', 'dismiss', enabled=False)
ui.capture('error-pending-spinner')

scene('files')
text('report.pdf')
text('notes.md')
text('PDF · 240 KB')
text('MD · 3 KB')
ui.capture('two-files')

# Open ends in a sheet; keep navigation last so it cannot cover later root scenes.
scene('schedules')
assert button('schedule-pending')['AXLabel'] == catalog.text('native.chat.proposal.create')
assert button('schedule-created')['AXLabel'] == catalog.text('native.chat.proposal.open')
ui.capture('schedule-pending-created')
tap('schedule-pending')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'preview-answer:schedule-pending:confirm'
                         and i.get('AXLabel') == catalog.text('native.chat.proposal.open')
                         and i.get('enabled') is True for i in items),
        'Created schedule did not expose Open')
ui.capture('schedule-create-receipt')
tap('schedule-created')
ui.element('home-schedules-list')
ui.element('schedule:daily-review')
ui.capture('schedule-open')

