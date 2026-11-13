"""iPad split list (the Chats list) and its relocated actions, using offline Home fixtures."""
import sys
import catalog
from driver import UI
import pad
import rotation

ui = UI(sys.argv[1], sys.argv[2])


def labeled(label):
    return ui.wait(lambda items: next((item for item in items if item.get('AXLabel') == label), None), f'Missing {label}')


def tap_label(label):
    frame = labeled(label)['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--tap-style', 'physical', '--post-delay', '.6')


ui.element('ipad-detail-placeholder')
pad.show_list(ui)
chrome = pad.panel_chrome(ui)
panel = chrome['panel']
search = chrome['search']['frame']
settings = chrome['settings']['frame']
view_menu = chrome['view']['frame']
workspace_item = chrome['workspace']
workspace = workspace_item['frame']
fab = chrome['create']['frame']
ui.capture('sidebar-glass-fab')

# Record the landscape column hiding and returning; the bottom Settings / New Session bar travels with it.
rotation.rotate(ui, 'landscape')
try:
    pad.show_list(ui)
    wide = pad.panel_chrome(ui)
    ui.capture('landscape-sidebar')
    home = ui.element('ipad-home')['frame']
    screen = (round(home['width']), round(home['height']))
    band = (0, wide['settings']['frame']['y'], wide['panel']['width'] + 10, wide['settings']['frame']['height'])
    pad.record_tap(ui, catalog.system('hideSidebar'), 'landscape-hide', screen, band)
    labeled(catalog.system('showSidebar'))
    ui.capture('landscape-sidebar-hidden')
    pad.record_tap(ui, catalog.system('showSidebar'), 'landscape-show', screen, band)
    labeled(catalog.system('hideSidebar'))
    pad.panel_chrome(ui)
    ui.capture('landscape-sidebar-shown')
finally:
    rotation.restore_portrait(ui)
pad.show_list(ui)

# The split list is the Chats list: same view menu (scope, grouping, row details, archive) as iPhone.
ui.element('home-chat-list')
tap_label(catalog.text('inbox.settings.section.view'))
for key in ('scope.mine', 'scope.team', 'grouping.time', 'grouping.project', 'grouping.status', 'view.project', 'view.archived'):
    labeled(catalog.text(f'home.{key}'))
ui.capture('sidebar-view-menu')
tap_label(catalog.text('home.grouping.time'))
ui.element('ui-design')
tap_label(catalog.text('tabs.settings'))
close_settings = catalog.text('accessibility.closeSheet', title=catalog.text('tabs.settings'))
labeled(close_settings)
ui.capture('sidebar-settings')
tap_label(close_settings)
ui.wait(lambda items: not any(item.get('AXLabel') == close_settings for item in items), 'Settings did not close')
# UIKit dismisses the portrait overlay column when a sheet presents over it.
pad.show_list(ui)

tap_label(workspace_item['AXLabel'])
ui.wait(lambda items: any(i.get('AXLabel') == '我的超长工作区名称不能折行' for i in items), 'Missing native workspace menu')
ui.capture('workspace-menu')
tap_label('另一个工作区')
ui.element('ipad-detail-placeholder')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'ui-design' for item in items), 'Old workspace content survived switching')
ui.capture('workspace-switched')
pad.show_list(ui)
tap_label(catalog.workspace_switch('另一个工作区', count=0, total=0))
tap_label('我的超长工作区名称不能折行')
pad.show_list(ui)
ui.element('ui-design')
tap_label(catalog.text('tabs.newSession'))
ui.element('create-session-input')
ui.capture('new-session')
tap_label(catalog.text('accessibility.closeSheet', title=catalog.text('create.title')))
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'create-session-input' for item in items), 'New Session did not close')
pad.show_list(ui)
print('PASS: Workspace, search and view menu on top; Settings and New Session at the bottom; all remain usable.')
