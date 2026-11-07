"""Machine status, cache notice recovery, owner-only rename and the editor's machine ID."""
import json
import sys
from driver import UI
from sheet_background import capture_card
import catalog
from settings_states import notice, no_header_refresh, no_notice, spoken, tap

ui = UI(sys.argv[1], sys.argv[2])
owner_id = '7a341b7c-6be8-4a33-9a1a-220ce48c5098'
owner = f'setting:machine::{owner_id}'
teammate = 'setting:machine::8b452c8d-7cf9-4b44-8b2b-331df59d6109'


def toolbar(key):
    ui.axe('tap', '--label', catalog.text(key), '--post-delay', '.5')


for identifier in (owner, teammate):
    row = ui.element(identifier)
    assert row['frame']['height'] >= 44
    assert identifier.split('::')[1] in spoken(row), 'Same-name machine identity missing'
    assert catalog.text('devices.unknown') in spoken(row), 'Failed refresh claimed live presence'
stale = catalog.text('settings.state.staleAt', time='').strip()
assert stale in spoken(notice(ui)), 'Cached failure notice missing its age'
no_header_refresh(ui)
ui.capture('machines-cached-failure')

tap(ui, 'list-notice-action')
ui.wait(lambda items: any(item.get('AXUniqueId') == owner and catalog.text('devices.online') in spoken(item) for item in items), 'Owner presence did not recover')
no_notice(ui)
assert catalog.text('devices.offline') in spoken(ui.element(teammate))
assert catalog.text('settings.remote.ownerOnly') in spoken(ui.element(teammate)), 'Read-only lock is not spoken'
assert catalog.text('settings.remote.readOnly') not in spoken(ui.element(teammate)), 'Read-only sentence is still rendered'
ui.capture('machines-live')

tap(ui, teammate)
assert not any(item.get('AXUniqueId') == 'setting-name' for item in ui.state()), 'Read-only machine opened an editor'
tap(ui, owner)
assert ui.element('setting-name')['AXValue'] == 'Studio Mac'
assert any(owner_id in spoken(item) for item in ui.state()), 'Editor does not show the machine ID'
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('settings.remote.copyId') for item in items), 'Copy machine ID button missing')
assert any((item.get('AXLabel') or '').casefold() == catalog.text('settings.remote.machineId').casefold() for item in ui.state()), 'Machine ID is not its own grouped section'
capture_card(ui, 'machine-editor', 'setting-name')
tap(ui, 'setting-name')
ui.axe('tap', '--label', catalog.system('clear'), '--post-delay', '.2')
ui.type_into('setting-name', 'Studio Renamed')
capture_card(ui, 'machine-editor-focused', 'setting-name')
toolbar('settings.remote.save')
ui.wait(lambda items: any(catalog.text('settings.remote.conflict') in spoken(item) for item in items), 'Missing rename conflict')
assert ui.element('setting-name')['AXValue'] == 'Studio Renamed', 'Conflict lost the draft'
ui.capture('machine-conflict-draft')
toolbar('common.cancel')
tap(ui, owner)
assert ui.element('setting-name')['AXValue'] == 'Studio Mac', 'Conflict changed remote data'
tap(ui, 'setting-name')
ui.axe('tap', '--label', catalog.system('clear'), '--post-delay', '.2')
ui.type_into('setting-name', 'Studio Renamed')
toolbar('settings.remote.save')
ui.wait(lambda items: any(item.get('AXUniqueId') == owner and 'Studio Renamed' in spoken(item) for item in items), 'Rename did not refresh the list')
assert 'Studio Mac' in spoken(ui.element(teammate)), 'Rename affected the other same-name machine'
ui.capture('machine-renamed')
tap(ui, owner)
assert ui.element('setting-name')['AXValue'] == 'Studio Renamed'
toolbar('common.cancel')
ui.element(owner)
ui.capture('machine-returned')
print(json.dumps({'sameNameIdentity': True, 'noticeRecovered': True, 'readOnlyBlocked': True, 'editorShowsId': True, 'conflictRetainedDraft': True, 'renamePersisted': True}))
