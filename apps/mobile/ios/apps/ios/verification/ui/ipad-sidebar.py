"""iPad Sidebar layout and relocated actions, using offline Home fixtures."""
import subprocess
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

ui.screenshot('sidebar-ground')
screen_width = round(ui.element('ipad-home')['frame']['width'])
pixels = subprocess.check_output([
    'ffmpeg', '-v', 'error', '-i', str(ui.output / 'sidebar-ground.png'),
    '-vf', f'scale={screen_width}:-1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
], timeout=20)


def sample(x, y):
    return tuple(pixels[(round(y) * screen_width + round(x)) * 3 + channel] for channel in range(3))


ground = sample(panel['x'] + panel['width'] / 2, fab['y'] - 60)
assert max(ground) - min(ground) <= 3, ('The sidebar canvas is neutral, not the bluish system gray', ground)

head = ui.element('toggle:ui:local:lody')['frame']
assert abs(head['x'] - panel['x'] - 12) <= 1 and abs(panel['x'] + panel['width'] - head['x'] - head['width'] - 12) <= 1, \
    ('iPad section heads are inset bands with 12 pt side margins', head, panel)

# Record the landscape sidebar hiding and returning; the bottom search must travel with its column.
rotation.rotate(ui, 'landscape')
try:
    pad.show_list(ui)
    wide = pad.panel_chrome(ui)
    ui.capture('landscape-sidebar')
    home = ui.element('ipad-home')['frame']
    screen = (round(home['width']), round(home['height']))
    band = (0, wide['search']['frame']['y'], wide['panel']['width'] + 10, wide['search']['frame']['height'])
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

tap_label(catalog.text('inbox.settings.section.view'))
for key in ('view.projects', 'view.activity', 'view.chat', 'sort.name', 'sort.activity', 'sort.urgency'):
    labeled(catalog.text(f'inbox.settings.{key}'))
ui.capture('sidebar-view-menu')
tap_label(catalog.text('inbox.settings.view.activity'))
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'toggle:ui:local:lody' for item in items), 'Activity view retained the project outline')
tap_label(catalog.text('inbox.settings.section.view'))
tap_label(catalog.text('inbox.settings.view.projects'))
ui.element('toggle:ui:local:lody')
tap_label(catalog.text('tabs.settings'))
close_settings = catalog.text('accessibility.closeSheet', title=catalog.text('tabs.settings'))
labeled(close_settings)
ui.capture('sidebar-settings')
tap_label(close_settings)
ui.wait(lambda items: not any(item.get('AXLabel') == close_settings for item in items), 'Settings did not close')
# UIKit dismisses the portrait overlay column when a sheet presents over it.
pad.show_list(ui)

tap_label(workspace_item['AXLabel'])
labeled(catalog.text('workspace.edit.action'))
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
print('PASS: Workspace at the top; view/settings at the bottom; workspace, view, settings and new-session actions remain usable.')
