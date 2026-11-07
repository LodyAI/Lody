"""Native Home lists, creation drafts, search, grouping and session actions."""
import subprocess
import sys
import time
from driver import UI
from sheet_background import capture_card
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def commit(text):
    ui.axe('type', text)
    # A Chinese App Language brings up the pinyin IME, which holds Latin letters as
    # composition until Return commits them verbatim.
    if catalog.LANGUAGE != 'en':
        ui.axe('key', '40')


def dismiss_search():
    labels = {catalog.system('cancel').lower(), catalog.system('close').lower()}
    button = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button' and (i.get('AXLabel') or '').lower() in labels), None), 'Missing search dismiss button')
    ui.axe('tap', '--label', button['AXLabel'], '--post-delay', '1')


def tap_create():
    ui.axe('tap', '--label', catalog.text('tabs.newSession'), '--post-delay', '1')


workspace_name = '我的超长工作区名称不能折行'
avatar_label = catalog.workspace_switch(workspace_name)


def home_ready():
    ui.wait(lambda items: any(i.get('AXLabel') == avatar_label for i in items), 'Missing workspace avatar')


def assert_swipe_has_no_selection(action_label):
    ui.wait(lambda items: any(i.get('AXLabel') == action_label for i in items), f'Missing swipe action {action_label}')
    row = ui.element('ui-design')
    assert 'selected' not in str(row.get('traits') or []).lower(), row


def assert_flat_ground(row, project):
    edit_label = catalog.text('workspace.edit.action')
    if any(i.get('AXLabel') == edit_label for i in ui.state()):
        ui.axe('tap', '-x', str(screen / 2), '-y', '700', '--post-delay', '.6')
    ui.wait(lambda items: not any(i.get('AXLabel') == edit_label for i in items), 'The workspace menu must not cover the list')
    ui.screenshot('rail-ground')
    width = round(screen)
    pixels = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(ui.output / 'rail-ground.png'),
        '-vf', f'scale={width}:-1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], timeout=20)

    def sample(x, y):
        return tuple(pixels[(round(y) * width + round(x)) * 3 + channel] for channel in range(3))
    edge = sample(4, row['y'] + row['height'] / 2)
    beside = sample(4, project['y'] + project['height'] / 2)
    gap = sample(4, project['y'] - 2)
    assert max(abs(a - b) for a, b in zip(edge, gap)) <= 6, ('Rows sit on the list ground, not an inset card', edge, gap)
    assert max(abs(a - b) for a, b in zip(beside, gap)) > 6, ('Project headers stand on their own band', beside, gap)
    native = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(ui.output / 'rail-ground.png'),
        '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], timeout=20)
    native_width = int(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0',
        str(ui.output / 'rail-ground.png'),
    ], timeout=20).decode().strip())
    scale = native_width / screen
    boundary = round((row['y'] + row['height']) * scale)

    def darkest(x):
        return min(native[(y * native_width) + round(x * scale)] for y in range(boundary - 3, boundary + 3))
    ground_level = native[(boundary - 12) * native_width + round(200 * scale)]
    for x in [30, 200, screen - 6]:
        assert abs(ground_level - darkest(x)) <= 3, ('Rows carry no hairline; spacing separates modules', x, ground_level, darkest(x))
    group = ui.element('toggle:pinned')['frame']
    top = round((group['y'] + group['height'] / 2 - 8) * scale)
    chevron = min(
        native[y * native_width + x]
        for y in range(top, top + round(16 * scale))
        for x in range(round((screen - 34) * scale), round((screen - 14) * scale))
    )
    band_level = native[(top + round(8 * scale)) * native_width + round(4 * scale)]
    assert abs(band_level - chevron) <= 3, ('Group rows draw no disclosure chevron', band_level, chevron)


close_create = catalog.text('accessibility.closeSheet', title=catalog.text('create.title'))

home_ready()
workspace = next(item for item in ui.state() if item.get('AXLabel') == avatar_label)
assert workspace['frame']['width'] > 200, workspace['frame']

def assert_model_row():
    item = ui.element('ui-design')
    labels = [item.get('AXLabel') or ''] + [child.get('AXLabel') or '' for child in item.get('children') or []]
    label = ' '.join(labels)
    assert label.index('feature/session-model') < label.index('GPT-6'), label

assert_model_row()
pinned = ui.element('toggle:pinned')
project = ui.element('toggle:ui:local:lody')
pinned_row = ui.element('ui-pinned')
assert pinned['frame']['y'] < project['frame']['y'], (pinned['frame'], project['frame'])
assert pinned_row['frame']['y'] < project['frame']['y'], (
    pinned_row['frame'],
    project['frame'],
)
if any(i.get('AXUniqueId') == 'xmark' and i.get('AXLabel') == catalog.system('close') for i in ui.state()):
    ui.axe('tap', '--id', 'xmark', '--post-delay', '1')
ui.capture('home')
rail_row = ui.element('ui-design')['frame']
screen = ui.state()[0]['frame']['width']
assert abs(rail_row['x']) <= 0.5 and abs(rail_row['width'] - screen) <= 1, ('Content rows span the full width', rail_row, screen)
assert_flat_ground(rail_row, ui.element('toggle:ui:local:lody')['frame'])
row = ui.element('ui-design')['frame']
y = row['y'] + row['height'] / 2
left = row['x'] + 12
right = row['x'] + row['width'] - 12
middle = row['x'] + row['width'] / 2
ui.axe('drag', '--start-x', str(right), '--start-y', str(y),
       '--end-x', str(middle), '--end-y', str(y), '--duration', '.6', '--post-delay', '.5')
archive_label = catalog.text('session.action.archive')
assert_swipe_has_no_selection(archive_label)
ui.capture('trailing-action')
ui.axe('drag', '--start-x', str(middle), '--start-y', str(y),
       '--end-x', str(right), '--end-y', str(y), '--duration', '.4', '--post-delay', '.4')
ui.axe('drag', '--start-x', str(left), '--start-y', str(y),
       '--end-x', str(middle), '--end-y', str(y), '--duration', '.6', '--post-delay', '.5')
pin_label = catalog.text('session.action.pin')
assert_swipe_has_no_selection(pin_label)
ui.capture('leading-action')
ui.axe('drag', '--start-x', str(middle), '--start-y', str(y),
       '--end-x', str(left), '--end-y', str(y), '--duration', '.4', '--post-delay', '.4')

# Catalog updates arrive continuously through the CRDT runtime. Pulling the
# inbox must only bounce; a refresh control would stay active because there is
# no asynchronous request lifecycle to finish.
before_pull = ui.element('ui-design')['frame']['y']
ui.axe('drag', '--start-x', '200', '--start-y', str(before_pull + 20),
       '--end-x', '200', '--end-y', str(before_pull + 240), '--duration', '.7', '--post-delay', '1')
after_pull = ui.element('ui-design')['frame']['y']
assert abs(after_pull - before_pull) <= 2, 'Pulling the CRDT inbox left a refresh control active'

tap_create()
ui.element('create-session-input')
ui.element('create-type')
capture_card(ui, 'create', 'project')
ui.wait(lambda items: any('Fixture Agent' in (i.get('AXLabel') or '') for i in items), 'Creation options did not load')
# Local machine ownership is explained on the project, not a one-choice picker.
assert 'Fixture Mac' in ui.element('project')['AXLabel']
assert not any(i.get('AXUniqueId') == 'machine' for i in ui.state())

# Exercise actual paging and a cancelled interactive sheet dismissal, not only
# segment taps. The video records the intervening cell motion.
for index in [1, 0, 1, 0]:
    before = ui.element('agent')['frame']
    width = ui.element('create-session-input')['frame']['width']
    start, end = (width - 20, 20) if index == 1 else (20, width - 20)
    y = before['y'] + before['height'] / 2
    ui.axe('drag', '--start-x', str(start), '--start-y', str(y),
           '--end-x', str(end), '--end-y', str(y), '--duration', '.7', '--post-delay', '.6')
    ui.element('create-type')
    assert any(i.get('AXUniqueId') == 'project' for i in ui.state()) == (index == 0), 'Swipe did not commit the expected page'
    after = ui.element('agent')['frame']
    ui.capture(f'create-swipe-{index}')
    time.sleep(.4)
    settled = ui.element('agent')['frame']
    assert abs(settled['y'] - after['y']) < 1 and abs(settled['height'] - after['height']) < 1, 'Cell geometry changed after paging settled'

header = next(item['frame'] for item in ui.state() if item.get('AXLabel') == close_create)
x, y = header['x'] + header['width'] / 2, header['y'] + header['height'] / 2
ui.axe('drag', '--start-x', str(x), '--start-y', str(y),
       '--end-x', str(x), '--end-y', str(y + 45), '--duration', '1', '--post-delay', '1')
ui.element('create-session-input')
ui.element('create-type')
ui.capture('create-dismiss-cancelled')


def tap_create_type(index):
    frame = ui.element('create-type')['frame']
    x = frame['x'] + frame['width'] * (0.25 if index == 0 else 0.75)
    y = frame['y'] + frame['height'] / 2
    ui.axe('tap', '-x', str(x), '-y', str(y), '--post-delay', '1')


tap_create_type(1)
ui.wait(
    lambda items: any(i.get('AXUniqueId') == 'machine' for i in items),
    'Chat page must show a computer row',
)
assert not any(i.get('AXUniqueId') == 'project' for i in ui.state())
ui.capture('create-chat')
tap_create_type(0)
ui.element('project')
# Expand from the close control so the title segment does not eat the swipe.
header = next(item['frame'] for item in ui.state() if item.get('AXLabel') == close_create)
start_x = header['x'] + header['width'] / 2
ui.axe(
    'drag',
    '--start-x', str(start_x),
    '--start-y', str(header['y'] + header['height'] / 2),
    '--end-x', str(start_x),
    '--end-y', '80',
    '--duration', '.6',
    '--post-delay', '.8',
)
expanded_header = next(item['frame'] for item in ui.state() if item.get('AXLabel') == close_create)
assert expanded_header['y'] < header['y'] - 100, 'Creation sheet did not expand to the full detent'
capture_card(ui, 'create-full', 'project')

# A repository with no existing sessions is discoverable, and can run on a
# teammate's shared machine. Local projects continue to pin their own machine.
project_row = next(item for item in ui.state() if item.get('AXUniqueId') == 'project')
pf = project_row['frame']
ui.axe(
    'tap',
    '-x', str(pf['x'] + pf['width'] / 2),
    '-y', str(pf['y'] + pf['height'] / 2),
    '--post-delay', '.5',
)
ui.axe('tap', '--label', catalog.text('projectPicker.github'), '--post-delay', '.5')
ui.element('github:LodyAI/FreshProject')
ui.capture('github-repositories')
ui.axe('tap', '--id', 'github:LodyAI/FreshProject', '--post-delay', '.7')
ui.axe('tap', '--id', 'machine', '--post-delay', '.5')
ui.element('shared')
ui.capture('github-machines')
ui.axe('tap', '--id', 'shared', '--post-delay', '.7')
assert 'Teammate Mac' in (ui.element('machine').get('AXLabel') or '')
assert 'Teammate Agent' in (ui.element('agent').get('AXLabel') or '')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'branch' and i.get('AXValue') == 'main' for i in items), 'Default branch was not selected')
ui.axe('tap', '--id', 'branch', '--post-delay', '.6')
ui.element('branch:develop')
ui.axe('tap', '--id', 'branch:develop', '--post-delay', '.6')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'branch' and i.get('AXValue') == 'develop' for i in items), 'Picked branch did not return to the form')
ui.capture('github-create')
# Configuration stays page-local while one native input carries the shared draft.
f = ui.element('create-session-input')['frame']
ui.axe('tap', '-x', str(f['x'] + f['width']/2), '-y', str(f['y'] + f['height']/2), '--post-delay', '.5')
ui.type_into('create-session-input', 'Shared draft')
shared_draft = ui.element('create-session-input')['AXValue']
ui.capture('shared-draft-project')
tap_create_type(1)
assert 'Fixture Mac' in ui.element('machine')['AXLabel']
assert ui.element('create-session-input')['AXValue'] == shared_draft, 'Switching to chat cleared the shared draft'
commit(' from chat')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'create-session-input' and (i.get('AXValue') or '').casefold() == (shared_draft + ' from chat').casefold() for i in items), 'Chat did not continue the shared draft')
shared_draft = ui.element('create-session-input')['AXValue']
ui.capture('shared-draft-chat')
tap_create_type(0)
assert 'Teammate Mac' in ui.element('machine')['AXLabel']
assert ui.element('branch')['AXValue'] == 'develop'
assert ui.element('create-session-input')['AXValue'] == shared_draft, 'Switching to project cleared the shared draft'
ui.capture('project-state-retained')
# Return through the picker while preserving the native sheet navigation.
project_row = next(item for item in ui.state() if item.get('AXUniqueId') == 'project')
pf = project_row['frame']
ui.axe(
    'tap',
    '-x', str(pf['x'] + pf['width'] / 2),
    '-y', str(pf['y'] + pf['height'] / 2),
    '--post-delay', '.5',
)
ui.axe('tap', '--label', catalog.text('projectPicker.local'), '--post-delay', '.5')
ui.axe('tap', '--id', 'ui:local:lody', '--post-delay', '.7')
assert not any(i.get('AXUniqueId') in ('machine', 'branch') for i in ui.state()), 'Local project retained GitHub configuration'
assert 'Fixture Mac' in ui.element('project')['AXLabel']
ui.element('create-type')

tap_create_type(1)
ui.wait(
    lambda items: any(i.get('AXUniqueId') == 'machine' for i in items),
    'Chat page must show a computer row',
)
ui.axe('tap', '--label', close_create, '--post-delay', '1')
home_ready()
tap_create()
ui.element('create-session-input')
ui.element('project')
assert not any(i.get('AXUniqueId') == 'machine' for i in ui.state()), (
    'New session must open on Project even after Chat was last used'
)
ui.axe('tap', '--label', close_create, '--post-delay', '1')
ui.capture('returned')

ui.axe('tap', '--id', 'magnifyingglass', '--post-delay', '.8')
commit('Search')
ui.element('ui-search')
assert not any(i.get('AXUniqueId') == 'ui-design' for i in ui.state())
ui.capture('search')
ui.axe('tap', '--label', catalog.system('clear'))
commit('Lody')
ui.element('project:ui:local:lody')
ui.capture('project-search')
ui.axe('tap', '--label', catalog.system('clear'))
commit('NoSuchSession')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('search.placeholder.noMatch') for i in items), 'Missing empty search state')
ui.capture('empty-search')
dismiss_search()
ui.element('ui-design')
assert not any(i.get('AXUniqueId') == 'ui-search' for i in ui.state())
ui.capture('cancelled')

view_label = catalog.text('inbox.settings.section.view')
ui.axe('tap', '--label', view_label, '--post-delay', '.8')
ui.capture('view-menu')
ui.axe('tap', '--label', catalog.text('inbox.settings.view.activity'), '--post-delay', '.8')
ui.element('ui-design')
assert not any(i.get('AXUniqueId') == 'toggle:ui:local:lody' for i in ui.state())
ui.capture('activity-view')
assert_model_row()
ui.axe('tap', '--label', view_label, '--post-delay', '.8')
ui.axe('tap', '--label', catalog.text('inbox.settings.view.chat'), '--post-delay', '.8')
ui.element('ui-chat')
chat = ui.element('ui-chat')
assert catalog.text('session.notRun') in str(chat), chat
assert not any(i.get('AXUniqueId') == 'toggle:ui:local:lody' for i in ui.state())
ui.capture('chat-view')
ui.axe('tap', '--label', view_label, '--post-delay', '.8')
ui.axe('tap', '--label', catalog.text('inbox.settings.sort.activity'), '--post-delay', '.8')
ui.axe('tap', '--label', view_label, '--post-delay', '.8')
ui.axe('tap', '--label', catalog.text('inbox.settings.view.projects'), '--post-delay', '.8')
ui.element('toggle:chat')
ui.element('toggle:pinned')
ui.element('ui-pinned')
project = ui.element('toggle:ui:local:lody')
# The outline parent is an accessibility container; its content view carries the label.
assert any('Lody iOS' in (child.get('AXLabel') or '') for child in project.get('children') or []), project


def tap_project():
    frame = ui.element('toggle:ui:local:lody')['frame']
    ui.axe('tap', '-x', str(frame['x'] + 120), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.8')


def group_actions(item):
    return sum([entry.get('custom_actions') or [] for entry in [item] + (item.get('children') or [])], [])


if catalog.text('native.list.collapse') not in group_actions(project):
    tap_project()
    project = ui.element('toggle:ui:local:lody')
assert catalog.text('native.list.collapse') in group_actions(project), project
tap_project()
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'ui-design' for i in items), 'Collapsing the project must hide its sessions')
ui.capture('project-collapsed')
tap_project()
ui.element('ui-design')
ui.capture('project-expanded')

empty = ui.element('project:ui:empty')
empty_label = empty.get('AXLabel') or ''
if not empty_label:
    empty_label = ' '.join(
        child.get('AXLabel') or '' for child in empty.get('children') or []
    )
assert '0' in empty_label, empty


def hold(identifier):
    frame = ui.element(identifier)['frame']
    ui.axe(
        'touch',
        '-x', str(frame['x'] + min(120, frame['width'] / 2)),
        '-y', str(frame['y'] + frame['height'] / 2),
        '--down', '--up', '--delay', '1.2',
    )
    time.sleep(1)


hold('project:ui:empty')
ui.wait(
    lambda items: any(catalog.text('project.action.copyPath') in (i.get('AXLabel') or '') for i in items),
    'Project long-press must show the copy-path action',
)
assert any(catalog.text('project.action.open') in (i.get('AXLabel') or '') for i in ui.state())
assert any(catalog.text('session.action.newSession') in (i.get('AXLabel') or '') for i in ui.state())
ui.capture('project-menu')
ui.axe('tap', '-x', '24', '-y', '120', '--post-delay', '.6')

hold('ui-design')
ui.wait(
    lambda items: any(catalog.text('session.action.pin') in (i.get('AXLabel') or '') for i in items),
    'Session long-press must show pin',
)
assert any(catalog.text('session.action.rename') in (i.get('AXLabel') or '') for i in ui.state()), 'Session long-press must show rename'
assert any(catalog.text('session.action.archive') in (i.get('AXLabel') or '') for i in ui.state())
assert any(catalog.text('session.action.share') in (i.get('AXLabel') or '') for i in ui.state()), 'Session long-press must show share'
user_turn = ui.wait(
    lambda items: next((i for i in items if (i.get('AXLabel') or '') == '设计首页'), None),
    'Session long-press must preview the cached user turn',
)
answer = next((i for i in ui.state() if (i.get('AXLabel') or '') == '用项目分组。'), None)
assert answer, 'Preview must show the assistant answer as readable text'
assert user_turn['frame']['width'] >= 200, user_turn
assert answer['frame']['width'] >= 200, answer
ui.capture('session-menu')
ui.axe('tap', '--label', catalog.text('session.action.rename'), '--post-delay', '.8')
ui.wait(
    lambda items: any(
        i.get('type') == 'TextField' and (i.get('AXValue') or '') == '首页交互设计'
        for i in items
    ),
    'Rename must prefill the session title',
)
ui.capture('session-rename')
ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.6')

print('PASS: native Home create/draft handoff, integrated search, grouping, session preview and rename cancellation.')
