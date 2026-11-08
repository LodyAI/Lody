"""Home workspace panel (workspaces only, trailing checkmark) and Settings icon/name editing reflected in it."""
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

def open_panel(label):
    ui.axe('tap', '--label', label, '--post-delay', '.5')
    panel = ui.element('workspace-panel')
    current = ui.element('workspace-row:ui-home')
    # The checkmark sits at the far right of the current row, which VoiceOver reads as selected.
    assert current['frame']['height'] >= 44, current
    assert 'selected' in str(current.get('traits') or []).lower(), current
    texts = {i.get('AXLabel') for i in ui.state()}
    assert catalog.text('workspace.edit.action') not in texts, 'Edit Workspace moved to Settings'
    assert catalog.text('devices.title') not in texts, 'Devices moved to Settings'
    return panel


def close_panel():
    ui.axe('tap', '--id', 'workspace-row:ui-home', '--post-delay', '.6')
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'workspace-panel' for i in items), 'Choosing the current workspace closes the panel')


open_panel(avatar_label)
ui.capture('workspace-menu')
close_panel()
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
open_panel(renamed_label)
ui.capture('workspace-menu-after-edit')
close_panel()
print('PASS: the workspace panel lists only workspaces with a trailing checkmark; the Settings editor returns icon selection and the saved name updates the Home capsule and panel.')
