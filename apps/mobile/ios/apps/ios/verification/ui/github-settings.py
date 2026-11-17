"""Unavailable load, native repository switches with an unconfirmed write and readback, and repository search."""
import json,sys
from driver import UI
import catalog
from settings_states import no_header_refresh, no_notice, notice, spoken, tap, try_again, unavailable
ui=UI(sys.argv[1],sys.argv[2])
unavailable(ui,'settings.unavailable.github');ui.capture('github-unverified');try_again(ui)
assert catalog.text('settings.github.expired') in spoken(ui.element('identity'))
repo='repo:LodyAI/Lody';switch=repo+':toggle'
def state(identifier):return ui.element(identifier).get('AXValue')
def flip(identifier):
    ui.wait(lambda items:any(item.get('AXUniqueId')==identifier and item.get('enabled') for item in items),'Repository switch is not ready')
    ui.tap_switch(ui.element(identifier))
assert state(switch)=='1','Enabled repository switch is off'
assert state('repo:LodyAI/lody-ios:toggle')=='0','Disabled repository switch is on'
no_header_refresh(ui)
ui.capture('github-repositories')
flip(switch)
notice(ui,'settings.state.unconfirmed')
assert catalog.text('settings.github.expired') in spoken(ui.element('identity')),'Unconfirmed write cleared the shown state'
assert state(switch)=='1','An unconfirmed write must return the switch to the read value'
assert not ui.element(switch).get('enabled',True),'Repository stayed editable after an unconfirmed write'
ui.capture('github-write-unconfirmed');tap(ui,'list-notice-action')
ui.wait(lambda items:any(item.get('AXUniqueId')==switch and item.get('enabled') for item in items),'Re-read did not unlock the repository')
no_notice(ui)
flip(switch)
ui.wait(lambda items:any(item.get('AXUniqueId')==switch and item.get('AXValue')=='0' and item.get('enabled') for item in items),'Repository enable state not read back')
assert catalog.text('settings.github.expired') in spoken(ui.element('identity'))
ui.capture('github-repository-disabled')
field=ui.wait(lambda items:next((i for i in items if i.get('subrole')=='AXSearchField'),None),'Repository search missing')['frame']
ui.axe('tap','-x',str(field['x']+field['width']/2),'-y',str(field['y']+field['height']/2),'--post-delay','.6')
ui.axe('type','loro','--post-delay','.6')
ui.element('repo:loro-dev/loro')
ui.wait(lambda items:not any(i.get('AXUniqueId') in (repo,'identity','install') for i in items),'Search kept unrelated rows')
ui.capture('github-search')
print(json.dumps({'nativeSwitches':True,'unconfirmedWriteLocked':True,'repoReadback':True,'repositorySearch':True,'noRealAuthorization':True}))
