"""Native Home workspace menu and Settings icon/name editing reflected in it."""
import sys
import time
import subprocess
from pathlib import Path
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
workspace_name = '我的超长工作区名称不能折行'
avatar_label = catalog.workspace_switch(workspace_name)
def home_ready():
    ui.wait(lambda items: any(i.get('AXLabel') == avatar_label for i in items), 'Missing workspace avatar')
home_ready()

def menu_row(name):
    return ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == name), None), 'Missing native workspace action: ' + name)

def open_menu(label):
    ui.axe('tap', '--label', label, '--post-delay', '.5')
    menu_row(workspace_name)
    menu_row("preview@example.test")
    texts = {i.get('AXLabel') for i in ui.state()}
    assert catalog.text('workspace.edit.action') not in texts
    assert catalog.text('devices.title') not in texts

def close_menu():
    ui.axe('tap', '--label', workspace_name, '--post-delay', '.6')
    ui.wait(lambda items: not any(i.get('AXLabel') == workspace_name for i in items), 'Menu did not close')

open_menu(avatar_label)
ui.capture('workspace-menu')
ui.axe('tap', '-x', '350', '-y', '700', '--post-delay', '.5')
ui.wait(lambda items: not any(i.get('AXLabel') == workspace_name for i in items), 'Outside tap did not dismiss menu')
home_ready()
open_menu(avatar_label)
close_menu()
home_ready()
open_menu(avatar_label)
ui.axe('drag', '--start-x', '140', '--start-y', '510', '--end-x', '140', '--end-y', '260', '--duration', '1', '--post-delay', '.5')
ui.capture('workspace-menu-scrolled')
last = menu_row('Workspace 5 — Research and international collaboration with a very long name')
ui.axe('tap', '--label', last['AXLabel'], '--post-delay', '.6')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'workspace-menu' and 'Workspace 5' in (i.get('AXLabel') or '') for i in items), 'Workspace selection did not update the capsule')
ui.axe('tap', '--id', 'workspace-menu', '--post-delay', '.5')
menu_row(workspace_name)
ui.capture('workspace-menu-selection-updated')
close_menu()
home_ready()
# The workspace editor lives in Settings › General.
ui.axe('tap', '--id', 'home-tab-settings', '--post-delay', '.6')
ui.axe('tap', '--id', 'workspace-general', '--post-delay', '.8')
ui.element('workspace-name')
ui.wait(
    lambda items: any(i.get('AXLabel') == catalog.text('workspace.edit.nameFooter') for i in items)
    and any(i.get('AXLabel') == catalog.text('workspace.edit.changeIcon') for i in items),
    'Workspace editor must show the name footer and the icon control',
)
ui.capture('workspace-editor')
ui.axe('tap', '--label', catalog.text('workspace.edit.changeIcon'), '--post-delay', '1')
# PHPicker's remote accessibility tree is absent on Simulator. Reuse the
# visible-text readiness check before selecting the captured fixture thumbnail.
reader = ui.output / 'system-picker-text'
subprocess.run(['xcrun', 'swiftc', str(Path(__file__).with_name('system-picker-text.swift')),
                '-o', str(reader)], check=True, timeout=60)
picker_image = ui.output / 'workspace-picker-loading.png'
def picker_ready(_):
    subprocess.run(['xcrun', 'simctl', 'io', ui.udid, 'screenshot', str(picker_image)],
                   check=True, capture_output=True, timeout=20)
    visible = subprocess.check_output([str(reader), str(picker_image)], text=True, timeout=10)
    return 'Photos' in visible and 'Collections' in visible
ui.wait(picker_ready, 'System workspace photo picker did not finish loading')
ui.capture('workspace-icon-picker')
ui.axe('tap', '-x', '67', '-y', '379', '--post-delay', '1.5')
ui.element('workspace-name')
ui.capture('workspace-icon-updated')
ui.axe('tap', '--id', 'workspace-name', '--post-delay', '.5')
ui.axe('tap', '--label', catalog.system('clear'), '--post-delay', '.2')
ui.type_into('workspace-name', 'Workspace renamed')
renamed = ui.element('workspace-name')['AXValue']
ui.capture('workspace-editor-filled')
ui.axe('tap', '--label', catalog.text('workspace.edit.save'), '--post-delay', '1')
renamed_label = catalog.workspace_switch(renamed)
ui.element('workspace-general')
ui.axe('tap', '--id', 'home-tab-chats', '--post-delay', '.6')
ui.wait(
    lambda items: any(i.get('AXLabel') == renamed_label for i in items),
    'Saving the workspace name must update the home capsule',
)
ui.capture('workspace-renamed')
workspace_name = renamed
open_menu(renamed_label)
ui.capture('workspace-menu-after-edit')
close_menu()
print('PASS: the native workspace menu selects, dismisses outside, reopens and updates; the Settings editor returns icon selection and the saved name updates the Home capsule and menu.')
