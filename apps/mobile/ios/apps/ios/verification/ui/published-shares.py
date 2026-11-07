"""Production inventory: failed reads, cursor paging, native link actions, conflict/uncertain revoke and scope."""
import json,sys
from driver import UI
from settings_states import try_again
import catalog
ui=UI(*sys.argv[1:])
def spoken(item):return ' '.join([str(item.get(k) or '') for k in ('AXLabel','AXValue')]+[spoken(c) for c in item.get('children') or []])
def reveal(identifier):
    for _ in range(10):
        items=ui.state();node=next((i for i in items if i.get('AXUniqueId')==identifier),None);h=items[0]['frame']['height']
        if node and 135<node['frame']['y'] and node['frame']['y']+node['frame']['height']<h-30:return node
        down=node is not None and node['frame']['y']<135
        if node is None and (identifier.startswith('share:') or identifier.startswith('list-notice')):down=True
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
    f=ui.wait(button,'Missing alert button '+text)['frame'];ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.5')
def back():
    node=ui.wait(lambda items:max((i for i in items if i.get('AXUniqueId')=='BackButton'),key=lambda i:i['frame']['y'],default=None),'Missing detail back')
    f=node['frame'];ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.6')
def notice(key):
    reveal('list-notice-text')
    expected=catalog.text('settings.shares.'+key)
    ui.wait(lambda items:any(i.get('AXUniqueId')=='list-notice-text' and expected in spoken(i) for i in items),'Missing notice '+expected)
ui.element('list-unavailable-action');ui.capture('shares-read-failed');try_again(ui);ui.element('share:own');ui.element('share:teammate');assert 'Conversations: 2 · 1 KB' in spoken(ui.element('share:own'));assert 'Page 1' in ' '.join(spoken(i) for i in ui.state());ui.capture('shares-server-inventory')
tap('shares-next');reveal('list-notice-action');assert catalog.text('settings.shares.pageFailed') in spoken(ui.element('list-notice-text'));ui.capture('shares-page-failed');tap('list-notice-action');ui.element('share:missing');ui.capture('shares-page-two')
tap('share:missing');ui.element('share-source');assert 'deleted-source' in spoken(ui.element('share-source'))
assert not any(i.get('AXUniqueId') in ('share-copy','share-open') for i in ui.state())
ui.capture('shares-source-deleted-key-missing');back();tap('shares-previous');ui.element('share:teammate');tap('share:teammate')
ui.element('share-publisher');assert 'teammate' in spoken(ui.element('share-publisher'));assert not any(i.get('AXUniqueId') in ('share-copy','share-open') for i in ui.state());reveal('share-revoke');ui.capture('shares-admin-without-key');back()
tap('share:own');ui.element('share-copy');tap('share-copy');notice('copied');ui.capture('shares-native-copy')
tap('share-revoke');ui.capture('shares-revoke-confirm');label(catalog.text('common.cancel'));ui.element('share-revoke')
tap('share-revoke');label(catalog.text('settings.shares.revoke'));notice('error.conflict');ui.capture('shares-stale-revision')
tap('list-notice-action');ui.element('share-revoke');tap('share-revoke');label(catalog.text('settings.shares.revoke'));notice('error.write_unknown');ui.capture('shares-revoke-unknown')
tap('share-revoke');assert not any(i.get('type')=='Alert' for i in ui.state()),'Uncertain revoke offered replay'
tap('list-notice-action');ui.wait(lambda items:any(i.get('AXUniqueId')=='share-status' and catalog.text('settings.shares.status.revoked') in spoken(i) for i in items),'Revocation readback missing')
assert not any(i.get('AXUniqueId') in ('share-revoke','share-copy','share-open') for i in ui.state());ui.capture('shares-revoked-readback');back()
tap('shares-next');tap('share:switch');tap('share-copy');ui.element('shares-scope-switched');assert not any(i.get('AXUniqueId')=='share-title' for i in ui.state());ui.capture('shares-account-switched')
ui.open_case('settings-baseline-live');reveal('published-shares');ui.capture('shares-settings-entry');tap('published-shares');ui.element('list-unavailable-action');ui.capture('shares-settings-offline')
print(json.dumps({'serverInventory':True,'pagingFailureRetainsPage':True,'copyNative':True,'sourceRemovalKeepsShare':True,'administratorCannotReadForeignKey':True,'uncertainRevokeBlockedUntilReadback':True,'scopeClosesDetails':True}))
