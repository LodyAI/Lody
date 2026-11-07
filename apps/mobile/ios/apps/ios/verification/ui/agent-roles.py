"""Role management: access recovery, ownership, retained drafts, create/readback and uncertain deletion."""
import json,sys
from driver import UI
from settings_states import pull,try_again,unavailable,no_header_refresh
import catalog
ui=UI(*sys.argv[1:])
def spoken(item):return ' '.join([str(item.get(key) or '') for key in ('AXLabel','AXValue')]+[spoken(child) for child in item.get('children') or []])
def tap(identifier):
    f=ui.element(identifier)['frame']
    if identifier=='role-shared':
        # UISwitch needs a real finger interval; an instantaneous simulator tap may miss its recognizer.
        step=f"touch -x {f['x']+f['width']*.75} -y {f['y']+f['height']/2} --down --up --delay .15"
        ui.axe('batch','--step',step,'--step','sleep .5')
    else:ui.axe('tap','--id',identifier,'--post-delay','.4')
def toolbar(key):
    node=ui.wait(lambda items:max((item for item in items if item.get('AXLabel')==catalog.text(key) and item.get('type')=='Button'),key=lambda item:item['frame']['y'],default=None),'Missing '+key)
    f=node['frame'];ui.axe('tap','-x',str(f['x']+f['width']/2),'-y',str(f['y']+f['height']/2),'--post-delay','.5')
def reveal_name():
    for _ in range(3):
        if ui.element('role-name')['frame']['y'] >= 145:break
        ui.axe('swipe','--start-x','70','--start-y','350','--end-x','70','--end-y','650','--duration','.4','--post-delay','.3')
def name(value):
    reveal_name()
    tap('role-name')
    ui.wait(lambda items:any((item.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar') and item['frame']['y']<items[0]['frame']['height']-150 for item in items),'Keyboard did not open')
    if ui.element('role-name').get('AXValue'):ui.axe('tap','--label',catalog.system('clear'),'--post-delay','.2')
    ui.axe('type',value)
    ui.wait(lambda items:any(item.get('AXUniqueId')=='role-name' and item.get('AXValue')==value for item in items),'Name input did not commit')
def failure(key):ui.wait(lambda items:any(item.get('AXUniqueId')=='role-error' and catalog.text(key) in spoken(item) for item in items),'Missing '+key)
def scroll_to(identifier):
    for _ in range(4):
        items=ui.state();node=next((item for item in items if item.get('AXUniqueId')==identifier),None)
        if node and 120<node['frame']['y']<items[0]['frame']['height']-80:return
        h=items[0]['frame']['height'];ui.axe('swipe','--start-x','80','--start-y',str(h*.7),'--end-x','80','--end-y',str(h*.35),'--duration','.4','--post-delay','.3')
    raise AssertionError('Not visible: '+identifier)
unavailable(ui,'settings.roles.unavailable');ui.capture('roles-load-failed');try_again(ui)
ui.element('role:review');no_header_refresh(ui)
assert catalog.text('settings.roles.ownerOnly') in spoken(ui.element('role:search'))
assert catalog.text('settings.roles.agentUnavailable') in spoken(ui.element('role:missing'))
ui.capture('roles-list')
tap('role:search');ui.element('role-name')
assert not any(item.get('AXLabel')==catalog.text('common.save') for item in ui.state()),'Non-owner can save'
assert not any(item.get('AXUniqueId')=='role-delete' for item in ui.state()),'Non-owner can delete'
ui.capture('roles-readonly');toolbar('common.cancel')
tap('role:multi');assert 'Laptop' in spoken(ui.element('role-targets'));assert 'Studio' in spoken(ui.element('role-targets'))
ui.capture('roles-multiple-targets');toolbar('common.cancel')
tap('role:review');name('Search');toolbar('common.save');failure('settings.roles.duplicate');reveal_name();ui.capture('roles-duplicate')
name('Mobile');toolbar('common.save');failure('settings.remote.conflict')
assert ui.element('role-name')['AXValue']=='Mobile';reveal_name();ui.capture('roles-draft-retained');toolbar('common.cancel')
tap('role:review');tap('role-shared');ui.wait(lambda items:any(item.get('AXUniqueId')=='role-shared' and item.get('AXValue')=='1' for item in items),'Sharing toggle did not change');name('Mobile');toolbar('common.save')
ui.wait(lambda items:any(item.get('AXUniqueId')=='role:review' and 'Mobile' in spoken(item) for item in items),'Edit was not read back')
assert catalog.text('settings.roles.sharedValue') in spoken(ui.element('role:review'));tap('role:review');assert ui.element('role-name')['AXValue']=='Mobile';reveal_name();ui.capture('roles-edit-readback');toolbar('common.cancel')
toolbar('settings.roles.add');ui.element('role-name');assert ui.element('role-shared')['AXValue']=='0'
assert not next(item for item in ui.state() if item.get('AXLabel')==catalog.text('common.save'))['enabled']
reveal_name();ui.capture('roles-empty-create');tap('role-target');ui.element('1');tap('1');ui.wait(lambda items:any(item.get('AXUniqueId')=='role-target' and 'Laptop' in spoken(item) for item in items),'Selected target did not return to editor');name('Helper');toolbar('common.save')
created=ui.wait(lambda items:next((item for item in items if (item.get('AXUniqueId') or '').startswith('role:') and 'Helper' in spoken(item)),None),'New role missing')
created_id=created['AXUniqueId'];assert catalog.text('settings.roles.private') in spoken(created);assert 'Laptop' in spoken(created)
ui.capture('roles-created');tap(created_id);assert ui.element('role-name')['AXValue']=='Helper'
scroll_to('role-delete');tap('role-delete');ui.capture('roles-delete-confirmation');toolbar('common.cancel')
tap('role-delete');toolbar('common.delete');failure('settings.roles.unknown');ui.capture('roles-delete-unconfirmed')
assert not next(item for item in ui.state() if item.get('AXLabel')==catalog.text('common.save'))['enabled'],'Unknown write allows replay'
toolbar('common.cancel');pull(ui,'role:review',lambda items:not any(item.get('AXUniqueId')==created_id for item in items))
ui.capture('roles-deleted-readback')
tap('role:review');name('Switch');toolbar('common.save')
ui.element('role-scope-switched')
assert not any(item.get('AXUniqueId')=='role-name' for item in ui.state()),'Old account role editor remains visible'
ui.capture('roles-account-switched')
ui.open_case('settings-baseline-live');ui.element('agent-roles');ui.capture('roles-settings-entry');tap('agent-roles');ui.element('list-unavailable-action');ui.capture('roles-entry-offline')
ui.open_case('settings-baseline-live');ui.element('agent-roles');ui.capture('roles-entry-return')
print(json.dumps({'accessRecovered':True,'ownerOnly':True,'multiTargets':True,'draftRetained':True,'privateCreate':True,'readback':True,'uncertainDeleteNeverReplayed':True,'accountSwitchClosesEditor':True}))
