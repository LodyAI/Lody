"""Native Home workspace icon and name editing with reflected catalog updates."""
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

ui.axe('tap', '--label', avatar_label, '--post-delay', '.5')
ui.wait(
    lambda items: any(i.get('AXLabel') == catalog.text('workspace.edit.action') for i in items),
    'Workspace menu must include the edit action',
)
edit_workspace = next(i for i in ui.state() if i.get('AXLabel') == catalog.text('workspace.edit.action'))
assert 'selected' not in str(edit_workspace.get('traits') or []).lower(), edit_workspace
ui.capture('workspace-menu')
ui.axe('tap', '--label', catalog.text('workspace.edit.action'), '--post-delay', '.8')
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
ui.wait(
    lambda items: any(i.get('AXLabel') == renamed_label for i in items),
    'Saving the workspace name must update the home menu',
)
ui.capture('workspace-renamed')
ui.axe('tap', '--label', renamed_label, '--post-delay', '.5')
edit_workspace = next(i for i in ui.state() if i.get('AXLabel') == catalog.text('workspace.edit.action'))
assert 'selected' not in str(edit_workspace.get('traits') or []).lower(), edit_workspace
ui.capture('workspace-menu-after-edit')
print('PASS: workspace icon selection returns and the saved name updates the Home menu.')
