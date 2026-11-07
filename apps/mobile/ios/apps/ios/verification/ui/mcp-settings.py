"""MCP defaults, incomplete connections, retained drafts and confirmed deletion."""
import json
import sys
from driver import UI
from sheet_background import capture_card
import catalog
from settings_states import no_header_refresh, pull

ui = UI(sys.argv[1], sys.argv[2])

def spoken(item):
    return ' '.join([str(item.get(key) or '') for key in ('AXLabel', 'AXValue')] + [spoken(child) for child in item.get('children') or []])

def tap(identifier):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.4')

def toolbar(key):
    # Alerts and the underlying form both expose Cancel; target the visible alert.
    node = ui.wait(lambda items: max((item for item in items if item.get('AXLabel') == catalog.text(key) and item.get('type') == 'Button'), key=lambda item: item['frame']['y'], default=None), f'Missing {key}')
    frame = node['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.5')

def failure(key):
    ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting-error' and catalog.text(key) in spoken(item) for item in items), f'Missing {key}')

def rename(value):
    tap('setting-name')
    ui.wait(lambda items: any((item.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar') and item['frame']['y'] < items[0]['frame']['height'] - 150 for item in items), 'Keyboard did not open')
    ui.axe('tap', '--label', catalog.system('clear'), '--post-delay', '.2')
    ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting-name' and not item.get('AXValue') for item in items), 'Name did not clear')
    ui.axe('type', value)
    ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting-name' and item.get('AXValue') == value for item in items), 'Name input did not commit')

def enable_switch():
    toggle = ui.element('setting-enabled')['frame']
    point = ('-x', str(toggle['x'] + toggle['height'] / 2), '-y', str(toggle['y'] + toggle['height'] / 2))
    try:
        ui.axe('touch', *point, '--down')
    finally:
        ui.axe('touch', *point, '--up')

docs = 'setting:mcp::docs'
assert catalog.text('settings.mcp.defaultOff') in spoken(ui.element(docs))
assert catalog.text('settings.mcp.notConfigured') in spoken(ui.element('setting:mcp::missing'))
assert catalog.text('settings.remote.ownerOnly') in spoken(ui.element('setting:mcp::readonly')), 'Read-only lock is not spoken'
no_header_refresh(ui)
ui.capture('mcp-list')
tap('setting:mcp::readonly')
assert not any(item.get('AXUniqueId') == 'setting-name' for item in ui.state()), 'Read-only row opened editor'
tap('setting:mcp::missing')
enable_switch()
assert ui.element('setting-enabled')['AXValue'] == '0', 'Unconfigured connection can be enabled'
ui.capture('mcp-needs-connection')
toolbar('common.cancel')

tap(docs)
capture_card(ui, 'mcp-editor', 'setting-name')
enable_switch()
ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting-enabled' and item.get('AXValue') == '1' for item in items), 'MCP default toggle did not enable')
rename('Search')
toolbar('settings.remote.save')
failure('settings.remote.duplicate')
ui.capture('mcp-duplicate-draft')
assert ui.element('setting-name')['AXValue'] == 'Search'
rename('Mobile')
toolbar('settings.remote.save')
failure('settings.remote.saveFailed')
ui.capture('mcp-save-failure-retains-draft')
assert ui.element('setting-name')['AXValue'] == 'Mobile'
assert ui.element('setting-enabled')['AXValue'] == '1'
toolbar('settings.remote.save')
ui.wait(lambda items: any(item.get('AXUniqueId') == docs and catalog.text('settings.mcp.defaultOn') in spoken(item) for item in items), 'MCP default was not read back')
ui.capture('mcp-default-saved')
tap(docs)
assert ui.element('setting-name')['AXValue'] == 'Mobile'
assert ui.element('setting-enabled')['AXValue'] == '1'
ui.capture('mcp-default-readback')
tap('setting-delete')
ui.wait(lambda items: any(catalog.text('settings.mcp.deleteHint', name='Mobile') in spoken(item) for item in items), 'Missing deletion scope warning')
ui.capture('mcp-delete-confirmation')
toolbar('common.cancel')
ui.element('setting-name')
tap('setting-delete')
toolbar('common.delete')
failure('settings.remote.conflict')
ui.capture('mcp-delete-conflict')
assert ui.element('setting-name')['AXValue'] == 'Mobile'
toolbar('common.cancel')
ui.element(docs)
tap(docs)
tap('setting-delete')
toolbar('common.delete')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'setting:mcp::search' for item in items) and not any(item.get('AXUniqueId') == docs for item in items), 'Deleted server remains in list')
pull(ui, 'setting:mcp::search', lambda items: not any(item.get('AXUniqueId') == docs for item in items))
ui.wait(lambda items: not any(item.get('AXUniqueId') == docs for item in items), 'Refresh restored deleted server')
ui.capture('mcp-deleted-readback')
print(json.dumps({'readonlyBlocked': True, 'missingConnectionCannotEnable': True, 'duplicateRejected': True, 'failedSaveRetainedDraft': True, 'defaultReadback': True, 'deleteConfirmationAndConflict': True, 'deletedReadback': True}))
