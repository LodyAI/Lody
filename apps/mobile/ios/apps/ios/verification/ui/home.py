"""Native Home lists, creation drafts, search, grouping and session actions."""
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


def hold(identifier):
    frame = ui.element(identifier)['frame']
    ui.axe(
        'touch',
        '-x', str(frame['x'] + min(120, frame['width'] / 2)),
        '-y', str(frame['y'] + frame['height'] / 2),
        '--down', '--up', '--delay', '1.2',
    )
    time.sleep(1)


def tap_menu_option(label):
    # Project also appears among the row-detail options; grouping is the upper menu section.
    option = ui.wait(lambda items: min((i for i in items if i.get('AXLabel') == label),
                     key=lambda i: i['frame']['y'], default=None), f'Missing menu option {label}')
    frame = option['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.8')


def tap_label(identifier):
    frame = ui.element(identifier)['frame']
    ui.axe('tap', '-x', str(frame['x'] + 60), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.8')


close_create = catalog.text('accessibility.closeSheet', title=catalog.text('create.title'))

home_ready()
workspace = next(item for item in ui.state() if item.get('AXLabel') == avatar_label)
assert workspace['frame']['width'] > 200, workspace['frame']

# Every grouping starts with the Pinned group: its label, then its rows, above the other chats.
pinned = ui.element('label:pinned')['frame']
pinned_row = ui.element('ui-pinned')['frame']
design_row = ui.element('ui-design')['frame']
assert pinned['y'] < pinned_row['y'] < design_row['y'], (pinned, pinned_row, design_row)
assert '置顶的首页会话' in (ui.element('ui-pinned').get('AXLabel') or '')
if any(i.get('AXUniqueId') == 'xmark' and i.get('AXLabel') == catalog.system('close') for i in ui.state()):
    ui.axe('tap', '--id', 'xmark', '--post-delay', '1')
ui.capture('home')
rail_row = ui.element('ui-design')['frame']
screen = ui.state()[0]['frame']['width']
assert abs(rail_row['x']) <= 0.5 and abs(rail_row['width'] - screen) <= 1, ('Content rows span the full width', rail_row, screen)
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
hold('project:ui:local:lody')
ui.wait(
    lambda items: any(catalog.text('project.action.copyPath') in (i.get('AXLabel') or '') for i in items),
    'Project long-press must show the copy-path action',
)
assert any(catalog.text('project.action.open') in (i.get('AXLabel') or '') for i in ui.state())
assert any(catalog.text('session.action.newSession') in (i.get('AXLabel') or '') for i in ui.state())
ui.capture('project-menu')
ui.axe('tap', '-x', '24', '-y', '120', '--post-delay', '.6')
ui.element('project:ui:local:lody')
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
for key in ('scope.mine', 'scope.team', 'grouping.time', 'grouping.project', 'grouping.status', 'view.project', 'view.archived'):
    ui.wait(lambda items, key=key: any(i.get('AXLabel') == catalog.text('home.' + key) for i in items), f'Missing view option {key}')
ui.capture('view-menu')
tap_menu_option(catalog.text('home.grouping.project'))
ui.element('label:group:ui:local:lody')
ui.element('ui-design')
ui.element('ui-chat')
project_label = ui.element('label:group:ui:local:lody')['frame']
assert project_label['y'] < ui.element('ui-design')['frame']['y'], 'Project grouping lists chats under their project label'
ui.capture('project-grouping')

# A group label folds its rows and keeps its own place.
tap_label('label:group:ui:local:lody')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'ui-design' for i in items), 'Collapsing the project group must hide its chats')
ui.element('label:group:ui:local:lody')
ui.capture('project-collapsed')
tap_label('label:group:ui:local:lody')
ui.element('ui-design')
ui.capture('project-expanded')

ui.axe('tap', '--label', view_label, '--post-delay', '.8')
tap_menu_option(catalog.text('home.grouping.status'))
ui.element('ui-design')

# The Archived switch turns Chats into the archived list and back.
ui.axe('tap', '--label', view_label, '--post-delay', '.8')
tap_menu_option(catalog.text('home.view.archived'))
ui.element('ui-search')
assert not any(i.get('AXUniqueId') == 'ui-design' for i in ui.state()), 'Archived mode lists only archived chats'
ui.capture('archived')
ui.axe('tap', '--label', view_label, '--post-delay', '.8')
tap_menu_option(catalog.text('home.view.archived'))
ui.element('ui-design')
assert not any(i.get('AXUniqueId') == 'ui-search' for i in ui.state())

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

print('PASS: native Home create/draft handoff, integrated search, project menu, grouping, folding, archive switch, session preview and rename cancellation.')
