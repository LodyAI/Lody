"""Dynamic inbox groups keep confirmation, live, unread-completed and dated history apart."""
import sys
from driver import UI
import catalog

SECTIONS = ('attention', 'pinned', 'live', 'unread', 'today', 'yesterday', 'week', 'month', 'older')
HEADERS = tuple(catalog.text(f'inbox.section.{name}') for name in SECTIONS)
ORDER = (
    ('header', catalog.text('inbox.section.attention')),
    ('row', 'inbox-wait'),
    ('row', 'inbox-awaiting'),
    ('header', catalog.text('inbox.section.pinned')),
    ('row', 'inbox-pinned'),
    ('header', catalog.text('inbox.section.live')),
    ('row', 'inbox-live'),
    ('header', catalog.text('inbox.section.unread')),
    ('row', 'inbox-unread'),
    ('header', catalog.text('inbox.section.today')),
    ('row', 'inbox-today'),
    ('header', catalog.text('inbox.section.yesterday')),
    ('row', 'inbox-yesterday'),
    ('header', catalog.text('inbox.section.week')),
    ('row', 'inbox-week'),
    ('header', catalog.text('inbox.section.month')),
    ('row', 'inbox-month'),
    ('header', catalog.text('inbox.section.older')),
    ('row', 'inbox-older'),
)
TITLES = {
    'inbox-wait': '权限确认会话',
    'inbox-awaiting': '完成后等确认',
    'inbox-pinned': '已置顶的已读会话',
    'inbox-live': '正在运行的任务',
    'inbox-unread': '刚完成未查看',
    'inbox-today': '今天已读会话',
    'inbox-yesterday': '昨天已读会话',
    'inbox-week': '一周内已读',
    'inbox-month': '上个月已读',
    'inbox-older': '更早的已读',
}
# Conversation rows: title, optional pill, project, time. No status sentence, no chevron.
LABELS = {
    'inbox-wait': ('权限确认会话', catalog.text('inbox.badge.attention'), 'lody-ios', catalog.text('time.justNow')),
    'inbox-awaiting': ('完成后等确认', catalog.text('inbox.badge.attention'), 'lody-ios', catalog.text('time.justNow')),
    'inbox-live': ('正在运行的任务', 'lody-ios', catalog.text('time.justNow')),
    'inbox-unread': ('刚完成未查看', 'lody-ios', catalog.plural('time.minutesAgo', 1)),
}

ui = UI(sys.argv[1], sys.argv[2])


def spoken(item):
    parts = [item.get('AXLabel') or '']
    for child in item.get('children') or []:
        parts.append(child.get('AXLabel') or '')
        for grandchild in child.get('children') or []:
            parts.append(grandchild.get('AXLabel') or '')
    return ' '.join(part for part in parts if part)


def token(item):
    uid = item.get('AXUniqueId') or ''
    if uid in TITLES:
        return ('row', uid)
    label = item.get('AXLabel') or ''
    if item.get('type') == 'Heading' and label in HEADERS:
        return ('header', label)
    return None


seen = []
for _ in range(12):
    visible = []
    for item in ui.state():
        found = token(item)
        if not found:
            continue
        visible.append((found, item))
        if found not in seen:
            seen.append(found)
    visible.sort(key=lambda pair: (pair[1]['frame']['y'], pair[1]['frame']['x']))
    onscreen = [found for found, _ in visible]
    expected = [found for found in ORDER if found in onscreen]
    assert onscreen == expected, (onscreen, expected)
    for found, item in visible:
        if found[0] != 'row':
            continue
        label = spoken(item)
        assert item['frame']['height'] >= 44, (found[1], item['frame'])
        assert TITLES[found[1]] in label, (found[1], label)
        if found[1] == 'inbox-yesterday':
            assert catalog.text('session.modelUnknown') not in label, label
            assert 'GPT-6' not in label and 'gpt-6' not in label, label
            ui.capture('model-unknown')
        elif found[1] == 'inbox-today':
            assert 'gpt-6' in label and 'feature/' not in label, label
        else:
            assert label.index('lody-ios') < label.index('feature/session-model') < label.index('GPT-6'), label
        if found[1] in LABELS:
            for part in LABELS[found[1]]:
                assert part in label, (found[1], label)
            assert catalog.text('session.state.live') not in label
            assert catalog.text('session.state.attention') not in label
    if all(found in seen for found in ORDER):
        break
    ui.axe(
        'swipe',
        '--start-x',
        '200',
        '--start-y',
        '700',
        '--end-x',
        '200',
        '--end-y',
        '240',
        '--duration',
        '.4',
        '--post-delay',
        '.3',
    )
else:
    raise AssertionError(f'Inbox groups were incomplete: {seen}')

assert seen == list(ORDER), seen
assert seen.index(('row', 'inbox-unread')) < seen.index(('header', catalog.text('inbox.section.today')))
assert seen.index(('row', 'inbox-awaiting')) < seen.index(('header', catalog.text('inbox.section.pinned')))
assert seen.index(('header', catalog.text('inbox.section.pinned'))) < seen.index(('header', catalog.text('inbox.section.live')))
ui.capture('groups')

unread = None
for _ in range(8):
    unread = next((item for item in ui.state() if item.get('AXUniqueId') == 'inbox-unread'), None)
    if unread:
        break
    ui.axe(
        'swipe',
        '--start-x',
        '200',
        '--start-y',
        '240',
        '--end-x',
        '200',
        '--end-y',
        '700',
        '--duration',
        '.4',
        '--post-delay',
        '.3',
    )
assert unread, 'Missing unread completed row'
ui.capture('before-viewing')
before = {item['AXUniqueId']: item['frame']['y'] for item in ui.state()
          if item.get('AXUniqueId') in TITLES}
ui.axe('tap', '--id', 'inbox-unread', '--post-delay', '1')
ui.element('inbox-viewed-detail')
ui.capture('viewing')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '1')
ui.element('inbox-unread')
after = {item['AXUniqueId']: item['frame']['y'] for item in ui.state()
         if item.get('AXUniqueId') in TITLES}
assert before.keys() == after.keys(), (before, after)
assert all(abs(before[key] - after[key]) <= 2 for key in before), (before, after)
assert any(i.get('type') == 'Heading' and i.get('AXLabel') == catalog.text('inbox.section.unread') for i in ui.state())
ui.capture('viewed-stable-order')
unread = ui.element('inbox-unread')
frame = unread['frame']
y = frame['y'] + frame['height'] / 2
ui.axe(
    'swipe',
    '--start-x',
    str(frame['x'] + frame['width'] - 12),
    '--start-y',
    str(y),
    '--end-x',
    str(frame['x'] + frame['width'] / 2),
    '--end-y',
    str(y),
    '--duration',
    '.6',
    '--post-delay',
    '.5',
)
read_label = catalog.text('session.action.read')
archive_label = catalog.text('session.action.archive')
ui.wait(lambda items: any(i.get('AXLabel') == read_label for i in items), 'Missing swipe 已读')
assert any(i.get('AXLabel') == archive_label for i in ui.state()), 'Unread swipe must keep archive beside 已读'
ui.capture('unread-read-action')
ui.axe('tap', '--label', read_label, '--post-delay', '1')
ui.wait(lambda items: not any(i.get('type') == 'Heading' and i.get('AXLabel') == catalog.text('inbox.section.unread') for i in items), 'Explicit read must remove the unread group')
ui.capture('explicitly-read')
ui.axe('tap', '--label', '新消息', '--post-delay', '1')
ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == catalog.text('inbox.section.unread') for i in items), 'A new message must restore the unread group')
ui.capture('new-message-emphasis')
print('Viewing preserves inbox positions and the explicit read action; only explicit read removes the unread group')
