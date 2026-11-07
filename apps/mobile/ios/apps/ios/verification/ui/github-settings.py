"""Independent expired identity and repository state, unavailable load, unconfirmed write and readback."""
import json,sys
from driver import UI
import catalog
from settings_states import no_header_refresh, no_notice, notice, spoken, tap, try_again, unavailable
ui=UI(sys.argv[1],sys.argv[2])
unavailable(ui,'settings.unavailable.github');ui.capture('github-unverified');try_again(ui)
assert catalog.text('settings.github.expired') in spoken(ui.element('identity'))
repo='repo:LodyAI/Lody'
def choose(identifier,key):
    label=catalog.text(key)
    ui.wait(lambda items:any(item.get('AXUniqueId')==identifier and item.get('enabled') for item in items),'Repository action is not ready')
    def option(items):
        return next((item for item in items if item.get('AXLabel')==label and item.get('type') in ('Button','MenuItem')),None)
    tap(ui,identifier,'.4')
    try:ui.wait(option,'Menu transition did not complete',timeout=3)
    except AssertionError:
        tap(ui,identifier,'.4')
        ui.wait(option,'Repository option missing')
    ui.axe('tap','--label',label,'--post-delay','.5')
assert catalog.text('settings.remote.enabled') in spoken(ui.element(repo))
no_header_refresh(ui)
ui.capture('github-scopes')
choose(repo,'settings.remote.disabled')
notice(ui,'settings.state.unconfirmed')
assert catalog.text('settings.github.expired') in spoken(ui.element('identity')),'Unconfirmed write cleared the shown state'
assert catalog.text('settings.remote.enabled') in spoken(ui.element(repo))
assert not ui.element(repo).get('enabled',True),'Repository stayed editable after an unconfirmed write'
ui.capture('github-write-unconfirmed');tap(ui,'list-notice-action')
ui.wait(lambda items:any(item.get('AXUniqueId')==repo and item.get('enabled') for item in items),'Re-read did not unlock the repository')
no_notice(ui)
choose(repo,'settings.remote.disabled')
ui.wait(lambda items:any(item.get('AXUniqueId')==repo and catalog.text('settings.remote.disabled') in spoken(item) for item in items),'Repository enable state not read back')
assert catalog.text('settings.github.expired') in spoken(ui.element('identity'))
ui.capture('github-repository-disabled')
print(json.dumps({'identitySeparateFromRepositories':True,'unconfirmedWriteLocked':True,'repoReadback':True,'noRealAuthorization':True}))
