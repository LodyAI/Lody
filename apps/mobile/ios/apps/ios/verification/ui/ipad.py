"""UIKit owns the iPad sidebar, column layout, navigation and reveal transitions."""
import shutil
import subprocess
import sys
import time

from driver import UI
import catalog
import pad
import rotation


ui = UI(sys.argv[1], sys.argv[2])


def screen_frame():
    return ui.state()[0]['frame']


def labeled(label):
    return ui.wait(
        lambda items: next(
            (item for item in items if item.get('AXLabel') == label), None
        ),
        f'Missing {label}',
    )


def search_field():
    return ui.wait(lambda items: next((item for item in items if item.get('subrole') == 'AXSearchField' or item.get('AXUniqueId') == 'sidebar-search'), None), 'Missing sidebar search')


def assert_split_column(name):
    screen = screen_frame()
    panel = ui.element('ipad-panel')['frame']
    assert screen['width'] >= 700, f'iPad check ran on a narrow device: {screen}'
    assert abs(panel['x'] - screen['x']) < 1, (panel, screen)
    assert panel['width'] < screen['width'] * .75, (panel, screen)
    assert panel['height'] >= screen['height'] - 30, (panel, screen)
    ui.capture(name)


def assert_panel_layout():
    panel = ui.element('ipad-panel')['frame']
    composer = ui.element('session-input')['frame']
    panel_right = panel['x'] + panel['width']
    assert composer['x'] > panel_right, (composer, panel)


def assert_panel_chrome():
    pad.panel_chrome(ui)


def assert_detail_content_fits():
    screen = screen_frame()
    panel = ui.element('ipad-panel')['frame']
    panel_right = panel['x'] + panel['width']
    screen_right = screen['x'] + screen['width']
    for identifier in ('u1:user', 'a1:process', 'a1:answer'):
        frame = ui.element(identifier)['frame']
        assert frame['x'] > panel_right, (identifier, frame, panel)
        assert frame['x'] + frame['width'] <= screen_right + .5, (identifier, frame, screen)


ui.element('ipad-detail-placeholder')
rotation.restore_portrait(ui)
pad.show_list(ui)
assert screen_frame()['height'] > screen_frame()['width']
assert_panel_chrome()
assert_split_column('portrait-home')

# Keep the same two-line rows and touch targets, with less empty space between projects.
project_row = ui.element('toggle:ui:local:lody')['frame']
session_row = ui.element('ui-design')['frame']
empty_row = ui.element('project:ui:empty')['frame']
assert project_row['height'] >= 44 and session_row['height'] >= 44
assert session_row['width'] >= ui.element('ipad-panel')['frame']['width'] - 24
assert empty_row['y'] - project_row['y'] < 130, (project_row, empty_row)
ui.axe('tap', '-x', str(project_row['x'] + 60),
       '-y', str(project_row['y'] + project_row['height'] / 2), '--post-delay', '.6')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'ui-design' for item in items),
        'Sidebar project did not collapse')
ui.capture('sidebar-project-collapsed')
project_row = ui.element('toggle:ui:local:lody')['frame']
ui.axe('tap', '-x', str(project_row['x'] + 60),
       '-y', str(project_row['y'] + project_row['height'] / 2), '--post-delay', '.6')
ui.element('ui-design')
ui.capture('sidebar-project-expanded')

# The stacked native search drives the production filter and clears it again.
field = search_field()['frame']
ui.axe('tap', '-x', str(field['x'] + field['width'] / 2), '-y', str(field['y'] + field['height'] / 2), '--post-delay', '.5')
ui.axe('type', 'lody')
ui.element('ui-design')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'project:ui:empty' for item in items),
        'Sidebar search did not filter the empty project')
ui.capture('sidebar-search-keyboard')
ui.axe('tap', '--label', catalog.system('clear'), '--post-delay', '.4')
ui.axe('key', '40')
ui.element('project:ui:empty')

# New Session opens the shared creation sheet; its inner navigation stays in that sheet.
ui.axe(
    'tap', '--label', catalog.text('tabs.newSession'),
    '--tap-style', 'physical', '--post-delay', '1',
)
ui.element('create-session-input')
ui.capture('create-sheet')
ui.axe('tap', '--id', 'project', '--post-delay', '.6')
ui.element('ui:local:lody')
ui.capture('create-project-picker')
ui.axe('tap', '--id', 'BackButton', '--tap-style', 'physical', '--post-delay', '.6')
ui.element('create-session-input')
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=catalog.text('create.title')),
       '--tap-style', 'physical', '--post-delay', '1')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'create-session-input' for item in items),
        'Creation sheet did not close')
pad.show_list(ui)
labeled(catalog.text('tabs.newSession'))

# The project is a second native page owned by the list navigation controller, with its own title
# and native Back button while the root detail remains unchanged.
ui.axe('tap', '--id', 'project:ui:empty', '--post-delay', '1')
ui.wait(
    lambda items: any(
        (item.get('AXLabel') or '') == catalog.text('project.newSession.accessibility')
        for item in items
    ),
    'Panel project action did not appear',
)
ui.element('BackButton')
ui.wait(
    lambda items: any((item.get('AXLabel') or '') == '空盒子' for item in items),
    'Panel project header did not appear',
)
ui.capture('project-pushed')

ui.axe('tap', '--id', 'BackButton', '--tap-style', 'physical', '--post-delay', '.8')


def create_and_send(landscape):
    name = 'landscape' if landscape else 'portrait'
    if any('UIKeyboard' in (item.get('AXUniqueId') or '') for item in ui.state()):
        hide = labeled('Hide keyboard')['frame']
        ui.axe('tap', '-x', str(hide['x'] + hide['width'] / 2),
               '-y', str(hide['y'] + hide['height'] / 2), '--post-delay', '.5')
    pad.show_list(ui)
    labeled(catalog.text('tabs.newSession'))
    ui.axe('tap', '--label', catalog.text('tabs.newSession'),
           '--tap-style', 'physical', '--post-delay', '1')
    ui.element('create-session-input')
    ui.axe('tap', '--id', 'create-session-input', '--post-delay', '.5')
    message = f'iPad {name} new message'
    ui.type_into('create-session-input', message)
    message = ui.element('create-session-input')['AXValue']
    ui.capture(f'{name}-before-send')
    print(f'SEND {name} at {time.time()}', flush=True)
    # The keyboard moves the sheet; ignore the underlying session's Send button.
    field = ui.element('create-session-input')['frame']
    send = min((item['frame'] for item in ui.state()
                if item.get('AXUniqueId') == 'session-send'
                and field['x'] <= item['frame']['x'] < field['x'] + field['width']),
               key=lambda frame: abs(frame['y'] - field['y'] - field['height']))
    ui.axe('tap', '-x', str(send['x'] + send['width'] / 2),
           '-y', str(send['y'] + send['height'] / 2), '--post-delay', '.8')
    ui.wait(lambda items: not any(item.get('AXUniqueId') == 'create-session-input' for item in items),
            'Creation sheet did not close after sending')
    ui.wait(lambda items: any(message in (item.get('AXLabel') or '') and
                             (item.get('AXUniqueId') or '').endswith(':user') for item in items),
            'New session did not retain the first message')
    ui.element('session-input')
    if landscape:
        labeled(catalog.system('hideSidebar'))
        assert_panel_layout()
    else:
        ui.wait(lambda items: not pad.list_visible(items) or None, 'The tall list stayed over the new session')
    ui.capture(f'{name}-after-send')


# The list sits beside the chat only in the wide layout; the tall layout hides it
# while a session is open.
rotation.rotate(ui, 'landscape')
try:
    ui.axe('tap', '--id', 'ui-design', '--post-delay', '1')
    ui.element('session-input')
    ui.element('ipad-panel')
    ui.element('chat-navigation-title')
    assert_panel_layout()
    assert_detail_content_fits()
    ui.capture('session-and-panel-headers')
    landscape = ui.output / 'session-and-panel-headers.png'
    shutil.copy2(landscape, ui.output / 'session-and-panel-headers-raw.png')
    subprocess.run(['sips', '-r', '90', str(landscape)], check=True, timeout=20)
    ui.axe('tap', '--id', 'session-input', '--tap-style', 'physical', '--post-delay', '.6')
    ui.capture('session-glass-focused')
    hide = labeled('Hide keyboard')['frame']
    ui.axe('tap', '-x', str(hide['x'] + hide['width'] / 2),
           '-y', str(hide['y'] + hide['height'] / 2), '--post-delay', '.5')
    ui.wait(lambda items: not any('UIKeyboard' in (item.get('AXUniqueId') or '') for item in items) or None,
            'The keyboard did not hide')

    # Exercise the translucent panel header with content moving through its soft
    # top scroll edge.
    panel = ui.element('ipad-panel')['frame']
    x = int(panel['x'] + panel['width'] / 2)
    ui.axe(
        'drag', '--start-x', str(x), '--start-y', '600',
        '--end-x', str(x), '--end-y', '300', '--duration', '.5', '--post-delay', '.7',
    )
    ui.capture('panel-scrolled-edge')

    ui.axe('tap', '--label', catalog.system('hideSidebar'), '--post-delay', '.5')
    expand = labeled(catalog.system('showSidebar'))
    assert expand['frame']['x'] < 100 and expand['frame']['y'] < 100, expand
    ui.element('chat-navigation-title')
    time.sleep(.4)
    ui.capture('panel-collapsed')
    ui.axe('tap', '--label', catalog.system('showSidebar'), '--post-delay', '.7')
    labeled(catalog.system('hideSidebar'))
    ui.element('chat-navigation-title')
    assert_panel_layout()

    # Verify the system page sheet is centered and narrower than the iPad window.
    # Its visual capture proves the opaque surface.
    ui.axe(
        'tap', '--label', catalog.text('tabs.settings'),
        '--tap-style', 'physical', '--post-delay', '1',
    )
    account = ui.element('account')['frame']
    screen = screen_frame()
    assert account['width'] < screen['width'] - 80, (account, screen)
    assert account['x'] > screen['x'] + 40, (account, screen)
    ui.capture('centered-opaque-settings')
    close = catalog.text('accessibility.closeSheet', title=catalog.text('tabs.settings'))
    ui.axe('tap', '--label', close, '--post-delay', '1')
    labeled(catalog.system('hideSidebar'))
    create_and_send(True)
finally:
    rotation.restore_portrait(ui)
assert screen_frame()['height'] > screen_frame()['width']
ui.element('chat-navigation-title')
create_and_send(False)

print('PASS: System sidebar, safe-area content, creation, selection, cancellation, navigation and rotation work in both orientations.')
