"""Settings General reuses the workspace editor and reflects its selected target."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
settings = catalog.text('tabs.settings')


def tap_label(label):
    ui.wait(lambda items: any(item.get('AXLabel') == label for item in items), f'Missing {label}')
    ui.axe('tap', '--label', label, '--post-delay', '.5')


def open_general():
    tap_label(settings)
    row = ui.element('workspace-general')
    assert row['frame']['height'] >= 44
    assert row['frame']['y'] < ui.element('remote-machine')['frame']['y']
    ui.capture('settings-general-entry')
    ui.axe('tap', '--id', 'workspace-general', '--post-delay', '.6')
    return ui.element('workspace-name')


def close_settings():
    tap_label(catalog.text('accessibility.closeSheet', title=settings))


original = '我的超长工作区名称不能折行'
ui.wait(lambda items: any(original in (item.get('AXLabel') or '') for item in items), 'Home fixture missing')
assert open_general()['AXValue'] == original
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('workspace.edit.changeIcon') for item in items), 'Missing existing icon control')
ui.capture('general-form')

# The runner seeds the same deterministic Photos fixtures as the existing picker checks.
tap_label(catalog.text('workspace.edit.changeIcon'))
ui.capture('icon-picker')
# Verified first thumbnail in the existing iPhone 17 Pro workspace-editor check.
ui.axe('tap', '-x', '67', '-y', '379', '--post-delay', '1')
ui.element('workspace-name')
ui.capture('icon-updated')
ui.axe('tap', '--id', 'workspace-name', '--post-delay', '.5')
ui.wait(lambda items: any((item.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar')
                         for item in items), 'English keyboard missing')
tap_label(catalog.system('clear'))
renamed = 'Workspace 2026'
ui.type_into('workspace-name', renamed)
ui.capture('name-draft')
tap_label(catalog.text('workspace.edit.save'))
ui.element('workspace-general')
ui.wait(lambda items: any(catalog.text('settings.section.workspaceNamed', name=renamed)
                         in (item.get('AXLabel') or '') for item in items), 'Settings did not reflect saved name')
ui.capture('name-saved')

ui.axe('tap', '--id', 'workspace-general', '--post-delay', '.5')
assert ui.element('workspace-name')['AXValue'] == renamed
ui.capture('saved-name-reopened')
tap_label(catalog.text('common.cancel'))
ui.element('workspace-general')
close_settings()

avatar = ui.wait(lambda items: next((item for item in items
                                    if (item.get('AXLabel') or '').startswith(catalog.text('inbox.workspaceSwitch.accessibility', name=renamed))), None), 'Home did not reflect saved name')
frame = avatar['frame']
ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.5')
tap_label('另一个工作区')
assert open_general()['AXValue'] == '另一个工作区'
ui.capture('other-workspace-target')
tap_label(catalog.text('common.cancel'))
ui.element('workspace-general')
close_settings()
print('PASS: Settings General reuses name/icon editing, saved values read back, and the next entry follows the selected workspace.')
