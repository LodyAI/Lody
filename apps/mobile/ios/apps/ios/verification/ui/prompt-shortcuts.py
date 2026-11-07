"""Shortcut access retry, empty-create validation, read-only templates and exact edit readback."""
import json,sys
from driver import UI
from sheet_background import capture_card
import catalog
from settings_states import try_again, unavailable
ui=UI(sys.argv[1],sys.argv[2])
def tap(identifier):ui.element(identifier);ui.axe('tap','--id',identifier,'--post-delay','.4')
def toolbar(key):ui.axe('tap','--label',catalog.text(key),'--post-delay','.5')
def spoken(item):return str(item.get('AXLabel',''))+' '+str(item.get('AXValue',''))
unavailable(ui,'settings.unavailable.shortcuts');ui.capture('access-failed');try_again(ui);ui.element('review')
assert '/review' in spoken(ui.element('review')),'Command name missing'
assert catalog.text('settings.shortcuts.viewOnly') in spoken(ui.element('scoped')),'View-only template is not marked'
assert catalog.text('settings.shortcuts.viewOnly') not in spoken(ui.element('review'))
ui.capture('shortcuts-list')
toolbar('settings.shortcuts.add')
assert not ui.element('shortcut-name').get('AXValue')
assert not next(item for item in ui.state() if item.get('AXLabel')==catalog.text('common.save'))['enabled']
ui.capture('shortcut-empty-create');toolbar('common.cancel')
tap('scoped')
assert ui.element('shortcut-name')['AXValue']=='Project Review'
assert not any(item.get('AXLabel')==catalog.text('common.save') for item in ui.state()),'Unsupported template can be overwritten'
ui.capture('shortcut-readonly');toolbar('common.cancel')
tap('review');capture_card(ui,'shortcut-editor','shortcut-prompt')
tap('shortcut-name')
key=ui.wait(lambda items:next((item for item in items if item.get('AXLabel')=='x' and item['frame']['height']>20),None),'Software keyboard key missing')
ui.axe('tap','--label',key['AXLabel'],'--post-delay','.4')
ui.wait(lambda items:any(item.get('AXUniqueId')=='shortcut-name' and item.get('AXValue')=='Reviewx' for item in items),'Name edit missing')
toolbar('common.save')
ui.wait(lambda items:any(catalog.text('settings.shortcuts.saveFailed') in spoken(item) for item in items),'Save failure not visible')
assert ui.element('shortcut-name')['AXValue']=='Reviewx'
ui.capture('shortcut-draft-retained');toolbar('common.retry')
ui.wait(lambda items:any(item.get('AXUniqueId')=='review' and 'Reviewx' in spoken(item) for item in items),'Saved shortcut missing')
ui.capture('shortcut-saved');tap('review')
assert ui.element('shortcut-name')['AXValue']=='Reviewx'
assert ui.element('shortcut-slug')['AXValue']=='review'
assert ui.element('shortcut-prompt')['AXValue']=='Review the current changes.'
ui.capture('shortcut-readback');toolbar('common.cancel')
print(json.dumps({'accessRetry':True,'emptyValidation':True,'readonlyBlocked':True,'saveRetryPreservedDraft':True,'exactReadback':True}))
