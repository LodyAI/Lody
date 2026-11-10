"""Registered visibility changes, owner-only controls and unknown-write readback."""
import json,sys
from driver import UI
import catalog
from settings_states import no_header_refresh, no_notice, notice
ui=UI(sys.argv[1],sys.argv[2])
def spoken(item):return str(item.get('AXLabel',''))+' '+str(item.get('AXValue',''))
def tap(identifier):ui.element(identifier);ui.axe('tap','--id',identifier,'--post-delay','.4')
def choose(identifier,key):
    label=catalog.text(key)
    ui.wait(lambda items:any(item.get('AXUniqueId')==identifier and item.get('enabled') for item in items),'Project action is not ready')
    def option(items):
        return next((item for item in items if item.get('AXLabel')==label and item.get('type') in ('Button','MenuItem')),None)
    tap(identifier)
    try:ui.wait(option,'Menu transition did not complete',timeout=3)
    except AssertionError:
        tap(identifier)
        ui.wait(option,'Project option missing')
    ui.axe('tap','--label',label,'--post-delay','.5')
owner='visibility:m1:same';foreign='visibility:m2:same'
assert catalog.text('settings.projects.private') in spoken(ui.element(owner))
assert catalog.text('settings.projects.othersOwner') in spoken(ui.element(foreign))
no_header_refresh(ui)
assert catalog.text('settings.projects.unknown') in spoken(ui.element('unknown:m1:local:unregistered'))
ui.capture('project-visibility-list')
choose(owner,'settings.projects.shared')
notice(ui,'settings.state.unconfirmed');assert catalog.text('settings.projects.private') in spoken(ui.element(owner))
assert not ui.element(owner).get('enabled',True),'Project stayed editable after an unconfirmed write'
ui.capture('visibility-unconfirmed')
tap('list-notice-action');no_notice(ui);choose(owner,'settings.projects.shared')
ui.wait(lambda items:any(item.get('AXUniqueId')==owner and catalog.text('settings.projects.sharedValue') in spoken(item) for item in items),'Visibility readback missing')
assert catalog.text('settings.projects.sharedValue') in spoken(ui.element(foreign))
ui.capture('visibility-shared')
choose(owner,'settings.projects.private')
ui.wait(lambda items:any(item.get('AXUniqueId')==owner and catalog.text('settings.projects.private') in spoken(item) for item in items),'Private readback missing')
ui.capture('visibility-private')
print(json.dumps({'ownerOnly':True,'unknownRegistration':True,'failedWriteRetainedState':True,'visibilityReadback':True}))
