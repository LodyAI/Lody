"""Independent empty/permission/readonly/readback-denied share scenes."""
import json,sys
from driver import UI
import catalog
ui=UI(*sys.argv[1:])
def spoken(item):return ' '.join([str(item.get(k) or '') for k in ('AXLabel','AXValue')]+[spoken(c) for c in item.get('children') or []])
def close_scene():
    if any(i.get('AXUniqueId')=='Share Details' for i in ui.state()):
        f=max((i for i in ui.state() if i.get('AXUniqueId')=='BackButton'),key=lambda i:i['frame']['y'])['frame']
        ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.5')
        ui.wait(lambda items:not any(i.get('AXUniqueId')=='Share Details' for i in items),'Detail did not close')
    buttons=[i for i in ui.state() if i.get('type')=='Button' and i.get('AXLabel')=='Close Published Shares']
    if buttons:
        f=buttons[-1]['frame'];ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.5')
        ui.wait(lambda items:not any(i.get('AXUniqueId')=='Published Shares' for i in items),'Previous scene did not close')
for state in ['empty','denied','readonly','readback-denied']:
    close_scene()
    ui.open_case('published-shares-'+state)
    if state=='empty':
        ui.element('shares-empty');assert not any((i.get('AXUniqueId') or '').startswith('share:') for i in ui.state());ui.capture('shares-empty');continue
    if state=='denied':
        ui.wait(lambda items:any(i.get('AXUniqueId')=='list-unavailable' and catalog.text('settings.shares.error.forbidden') in spoken(i) for i in items),'Permission message missing');ui.capture('shares-permission-denied');continue
    ui.element('share:own');ui.axe('tap','--id','share:own','--post-delay','.5');ui.element('share-status')
    if state=='readonly':
        assert not any(i.get('AXUniqueId')=='share-revoke' for i in ui.state());ui.capture('shares-readonly');continue
    # Scroll to the destructive action while keeping the native footer visible.
    for _ in range(5):
        node=next((i for i in ui.state() if i.get('AXUniqueId')=='share-revoke'),None)
        if node and node['frame']['y']+node['frame']['height']<ui.state()[0]['frame']['height']-30:break
        ui.axe('swipe','--start-x','65','--start-y','650','--end-x','65','--end-y','300','--duration','.4','--post-delay','.3')
    ui.axe('tap','--id','share-revoke','--post-delay','.4')
    def confirm(items):
        def walk(n):
            yield n
            for c in n.get('children') or []:yield from walk(c)
        sheet=next((i for i in items if i.get('type') in ('Sheet','Alert')),None)
        return next((i for i in walk(sheet) if i.get('type')=='Button' and i.get('AXLabel')==catalog.text('settings.shares.revoke')),None) if sheet else None
    f=ui.wait(confirm,'Missing confirmation')['frame'];ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.5')
    for _ in range(5):
        node=next((i for i in ui.state() if i.get('AXUniqueId')=='list-notice-action'),None)
        if node and node['frame']['y']>120:break
        ui.axe('swipe','--start-x','65','--start-y','300','--end-x','65','--end-y','650','--duration','.4','--post-delay','.3')
    ui.element('list-notice-action');ui.axe('tap','--id','list-notice-action','--post-delay','.5')
    ui.wait(lambda items:any(i.get('AXUniqueId')=='list-unavailable' and catalog.text('settings.shares.error.forbidden') in spoken(i) for i in items),'Readback denial did not clear old details')
    assert not any(i.get('AXUniqueId')=='share-title' for i in ui.state());ui.capture('shares-readback-permission-loss')
print(json.dumps({'emptyIsNotFailure':True,'permissionMessage':True,'readOnlyHasNoRevoke':True,'deniedReadbackClearsOldDetails':True}))
