"""Independently reset provider states retain associations and gate import."""
import json,sys
from driver import UI
import catalog
ui=UI(*sys.argv[1:])
def spoken(item):return ' '.join([str(item.get(k) or '') for k in ('AXLabel','AXValue')]+[spoken(c) for c in item.get('children') or []])
for machine in ['catalog_denied','not_installed','not_running','unsupported','error','forbidden','unknown','cached','empty']:
    ui.open_case('memory-state-'+machine)
    if machine=='catalog_denied':
        ui.wait(lambda items:any(i.get('AXUniqueId')=='list-unavailable' and catalog.text('settings.memory.forbidden') in spoken(i) for i in items),'Catalog denial was hidden by a generic connection error')
        ui.capture('memory-catalog-denied');continue
    expected='ready' if machine in ['cached','empty'] else machine
    ui.wait(lambda items:any(i.get('AXUniqueId')=='provider-status' and catalog.text('settings.memory.status.'+expected) in spoken(i) for i in items),'Missing provider status '+expected)
    if machine=='not_installed':ui.element('provider-install')
    if machine=='cached':assert catalog.text('settings.memory.cached') in spoken(ui.element('list-notice-text'))
    if machine not in ['empty','cached']:
        assert not any((i.get('AXUniqueId') or '').startswith('import:') for i in ui.state())
    ui.capture('memory-state-'+machine)
    if machine=='cached':
        identifier='saved:["nowledge-mem","review"]'
        ui.element(identifier);ui.axe('tap','--id',identifier,'--post-delay','.5')
        ui.element('memory-id');assert catalog.text('settings.memory.cached') in spoken(ui.element('list-notice-text'))
        ui.capture('memory-cached-details')
    if machine=='unsupported':
        identifier='saved:["future-provider","future"]'
        ui.element(identifier);ui.axe('tap','--id',identifier,'--post-delay','.5')
        assert catalog.text('settings.memory.unverifiedProvider') in spoken(ui.element('memory-status'))
        ui.capture('memory-unknown-provider-details')
print(json.dumps({'states':['missing-install','inactive','unsupported','failed','forbidden','unknown','cached','empty'],'unknownProviderIsNotNowledge':True,'unavailableDoesNotMeanDeleted':True}))
