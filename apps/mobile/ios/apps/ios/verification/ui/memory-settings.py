"""Memory identities: read failure, metadata details, import, uncertain unlink and scope cleanup."""
import json,sys
from driver import UI
from settings_states import try_again,pull
import catalog
ui=UI(*sys.argv[1:])
def spoken(item):return ' '.join([str(item.get(k) or '') for k in ('AXLabel','AXValue')]+[spoken(c) for c in item.get('children') or []])
def reveal(identifier):
    for _ in range(9):
        items=ui.state();node=next((i for i in items if i.get('AXUniqueId')==identifier),None)
        h=items[0]['frame']['height']
        if node and 135<node['frame']['y'] and node['frame']['y']+node['frame']['height']<h-30:return node
        down=(node['frame']['y']<135) if node is not None else identifier.startswith('machine:')
        ui.axe('swipe','--start-x','65','--start-y',str(h*(.35 if down else .75)),'--end-x','65','--end-y',str(h*(.75 if down else .35)),'--duration','.4','--post-delay','.3')
    raise AssertionError('Not visible '+identifier)
def tap(identifier):reveal(identifier);ui.axe('tap','--id',identifier,'--post-delay','.4')
def label(text):
    def button(items):
        sheet=next((i for i in items if i.get('type') in ('Sheet','Alert')),None)
        if not sheet:return None
        def walk(node):
            yield node
            for child in node.get('children') or []:yield from walk(child)
        return next((i for i in walk(sheet) if i.get('type')=='Button' and i.get('AXLabel')==text),None)
    node=ui.wait(button,'Missing alert button '+text)
    f=node['frame'];ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.5')
def saved(identity):return 'saved:'+json.dumps(['nowledge-mem',identity],separators=(',',':'))
def back():
    node=ui.wait(lambda items:max((i for i in items if i.get('AXUniqueId')=='BackButton'),key=lambda i:i['frame']['y'],default=None),'Missing detail back button')
    f=node['frame'];ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.6')
ui.element('list-unavailable-action');ui.capture('memory-load-failed');try_again(ui)
ui.element('machine:studio');reveal(saved('deleted'));assert catalog.text('settings.memory.missing') in spoken(ui.element(saved('deleted')));ui.capture('memory-list-authoritative-missing');tap(saved('review'));ui.element('memory-id');assert 'review' in spoken(ui.element('memory-id'));assert 'studio' in spoken(ui.element('memory-source'))
ui.capture('memory-identity-details');tap('memory-remove');ui.capture('memory-unlink-confirm');label(catalog.text('common.cancel'))
assert ui.element('memory-id');tap('memory-remove');label(catalog.text('settings.memory.remove'))
ui.wait(lambda items:any(i.get('AXUniqueId')=='list-notice-text' and catalog.text('settings.memory.writeUnknown') in spoken(i) for i in items),'Uncertain unlink missing')
ui.capture('memory-unlink-unconfirmed');tap('memory-remove');assert not any(i.get('type')=='Alert' for i in ui.state()),'Uncertain unlink offered replay'
back();reveal('machine:studio');pull(ui,'machine:studio',lambda items:not any(i.get('AXUniqueId')==saved('review') for i in items))
ui.capture('memory-unlink-readback');tap('import:new');ui.capture('memory-import-confirm');label(catalog.text('common.cancel'))
assert not any(i.get('AXUniqueId')==saved('new') for i in ui.state())
tap('import:new');label(catalog.text('settings.memory.import'));reveal('machine:studio');ui.wait(lambda items:any(i.get('AXUniqueId')=='list-notice-text' and catalog.text('settings.memory.status.not_running') in spoken(i) for i in items),'Import did not show provider failure');reveal('machine:studio');ui.capture('memory-import-provider-failed');pull(ui,'machine:studio',lambda items:not any(i.get('AXUniqueId')=='list-notice-text' for i in items));tap('import:new');label(catalog.text('settings.memory.import'));ui.wait(lambda items:any(i.get('AXUniqueId')==saved('new') for i in items),'Imported identity missing')
tap(saved('new'));assert 'new' in spoken(ui.element('memory-id'));ui.capture('memory-import-readback');back()
tap('machine:laptop');tap(saved('review'));assert 'laptop' in spoken(ui.element('memory-source'));assert catalog.text('settings.memory.status.offline') in spoken(ui.element('memory-status'));assert catalog.text('settings.memory.missing') not in spoken(ui.element('memory-status'));ui.capture('memory-other-source-offline');back()
tap('machine:studio');tap(saved('new'));tap('memory-remove');label(catalog.text('settings.memory.remove'));ui.element('memory-scope-switched');assert not any(i.get('AXUniqueId')=='memory-id' for i in ui.state());ui.capture('memory-account-switched')
ui.open_case('settings-baseline-live');reveal('memory-settings');ui.capture('memory-settings-entry');tap('memory-settings');ui.element('list-unavailable-action');ui.capture('memory-settings-entry-offline')
print(json.dumps({'metadataOnly':True,'sourceIsolated':True,'importReadback':True,'unlinkDoesNotDeleteProvider':True,'uncertainNeverReplayed':True,'accountScopeClosesDetails':True}))
