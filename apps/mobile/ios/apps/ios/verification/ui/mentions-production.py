"""Actual product screens expose @ and preserve the selected machine reference."""
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])

def tap(identifier):
    if identifier.startswith('mention-item:'):
        for _ in range(4):
            items = ui.state()
            panel = next(i['frame'] for i in items if i.get('AXUniqueId') == 'mention-panel')
            target = next((i['frame'] for i in items if i.get('AXUniqueId') == identifier), None)
            if target and target['y'] >= panel['y'] and target['y'] + target['height'] <= panel['y'] + panel['height']:
                break
            rows = [i['frame'] for i in items if (i.get('AXUniqueId') or '').startswith('mention-item:') and i.get('frame')]
            assert rows, 'Reference category panel missing'
            top = panel['y']
            bottom = panel['y'] + panel['height']
            x = rows[0]['x'] + rows[0]['width'] / 2
            ui.axe('swipe', '--start-x', str(x), '--start-y', str(bottom - 12), '--end-x', str(x), '--end-y', str(top + 12), '--duration', '.4', '--post-delay', '.3')
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', '.8')

def choose(field, host):
    tap(field)
    tap('session-mention')
    tap('mention-item:file')
    tap('mention-picker-item:src')
    ui.element('mention-picker-notice')
    ui.capture(host + '-files')
    tap('mention-picker-item:src/session.ts')
    assert '@src/session.ts' in ui.element(field).get('AXValue', ''), 'Selected file did not reach the real composer'
    tap('session-mention')
    tap('mention-item:skill')
    ui.capture(host + '-skills')
    tap('mention-picker-item:/fixture/skills/auth/SKILL.md')
    text = ui.element(field).get('AXValue', '')
    assert text.strip() == '@src/session.ts $auth-review', 'The real composer lost the machine skill path or prior draft'
    for kind, path, token in [
        ('session', 'ui-review', '@session:ui-review'),
        ('role', 'role-reviewer', '@role:role-reviewer'),
        ('issue', 'issue:11', '#11'),
        ('pr', 'pr:12', '#12'),
        ('cmd', 'compact', '/compact'),
    ]:
        previous = ui.element(field).get('AXValue', '')
        tap('session-mention')
        tap('mention-item:' + kind)
        ui.element('mention-picker-item:' + path)
        ui.capture(host + '-' + kind)
        tap('mention-picker-item:' + path)
        assert ui.element(field).get('AXValue', '') == previous + token + ' ', 'Lost or expanded a reference before send'
    ui.capture(host + '-draft')

# Start from the real inbox, not a manually wired composer preview.
tap('ui-design')
choose('session-input', 'chat')
ui.axe('tap', '--label', 'Back' if catalog.LANGUAGE == 'en' else '返回', '--post-delay', '1')
ui.element('ui-design')
buttons = [i for i in ui.state() if i.get('type') == 'Button' and i.get('frame')]
frame = max(buttons, key=lambda i: i['frame']['y'])['frame']
ui.axe('tap', '-x', str(frame['x'] + frame['width']/2), '-y', str(frame['y'] + frame['height']/2), '--post-delay', '1')
choose('create-session-input', 'sheet')
print('PASS: production chat and new-session screens browse all seven provider-shaped categories and retain short references')
