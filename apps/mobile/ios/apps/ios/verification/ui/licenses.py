"""Settings -> Open Source Licenses carries the app's own AGPL notice plus every bundled library and its full license text."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])

workspace_name = '我的超长工作区名称不能折行'
avatar_label = catalog.workspace_switch(workspace_name)


def dismiss_debug():
    if any(i.get('AXUniqueId') == 'xmark' and i.get('AXLabel') == catalog.system('close') for i in ui.state()):
        ui.axe('tap', '--id', 'xmark', '--post-delay', '1')


def home_ready():
    ui.wait(lambda items: any(i.get('AXLabel') == avatar_label for i in items), 'Missing workspace avatar')


dismiss_debug()
home_ready()
ui.capture('inbox')

settings_label = catalog.text('tabs.settings')
ui.axe('tap', '--label', settings_label, '--post-delay', '1')

# About is a child page of Settings; offscreen rows are not in the tree.
for _ in range(6):
    if any(i.get('AXUniqueId') == 'about' for i in ui.state()):
        break
    ui.axe('drag', '--start-x', '200', '--start-y', '600', '--end-x', '200', '--end-y', '400', '--duration', '.5', '--post-delay', '.5')
ui.axe('tap', '--id', 'about', '--post-delay', '.5')
row = ui.element('licenses')
assert catalog.text('settings.licenses.title') in (row.get('AXLabel') or ''), row
assert row['frame']['height'] >= 44, row
ui.capture('settings-row')
ui.axe('tap', '--id', 'licenses', '--post-delay', '1')

# The app's own AGPL notice leads the list, before the alphabetical libraries.
own = ui.element('Lody for iOS')
assert 'AGPL-3.0-only' in (own.get('AXLabel') or ''), own
ui.capture('app-license-row')
ui.axe('tap', '--id', 'Lody for iOS', '--post-delay', '1')
ui.wait(
    lambda items: any('GNU AFFERO GENERAL PUBLIC LICENSE' in (i.get('AXLabel') or '') for i in items),
    "The app's own AGPL text must be displayed",
)
ui.capture('app-license')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '1')
ui.element('Lody for iOS')

first = ui.element('base64-js')
assert 'MIT' in (first.get('AXLabel') or ''), first
ui.capture('list')

ui.axe('tap', '--id', 'base64-js', '--post-delay', '1')
ui.wait(
    lambda items: any('Permission is hereby granted' in (i.get('AXLabel') or '') for i in items),
    'Detail page must show the full license text',
)
ui.wait(lambda items: any(i.get('AXLabel') == 'base64-js' for i in items), 'Detail page must name the library')
ui.capture('detail')

ui.axe('tap', '--id', 'BackButton', '--post-delay', '1')
ui.element('base64-js')
ui.capture('back')

# Return through About before reaching the Settings sheet root.
ui.axe('tap', '--id', 'BackButton', '--post-delay', '1')
ui.element('licenses')
ui.capture('about-returned')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')
ui.element('about')
ui.capture('sheet-root')

ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=settings_label), '--post-delay', '1')
home_ready()
assert not any(i.get('AXUniqueId') == 'licenses' for i in ui.state())
ui.capture('closed')
print("Settings carries the app's own AGPL notice and every bundled library's full license text.")
