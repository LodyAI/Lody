"""Rich clipboard content pastes as formatted nodes in both hosts; a copied Lody reply keeps its Markdown."""
import json
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
identifier = next(item['AXUniqueId'] for item in ui.state()
                  if item.get('AXUniqueId') in ['session-input', 'create-session-input'])


def value():
    return ui.element(identifier).get('AXValue') or ''


ui.axe('tap', '--id', identifier, '--post-delay', '.6')
for _ in range(len(value()) + 4):
    ui.axe('key', '42')
ui.wait(lambda items: not value(), 'Could not clear the fixture draft')
ui.paste_html(identifier)
ui.wait(lambda items: 'item' in value(), f'HTML did not paste: {value()!r}')
assert value().startswith('Rich bold and code'), f'HTML tags or Markdown leaked into the input: {value()!r}'
assert '<b>' not in value() and '**' not in value(), f'Formatting was not converted: {value()!r}'
ui.capture('html-pasted')

if identifier == 'create-session-input':
    ui.axe('tap', '--id', 'session-send', '--post-delay', '.8')
    sent = json.loads(ui.element('composer-sent')['AXLabel'])
    assert sent.rstrip() == 'Rich **bold** and `code`\n- item', f'Sent body was not Markdown: {sent!r}'
else:
    for _ in range(len(value()) + 4):
        ui.axe('key', '42')
    actions = next(item['AXUniqueId'] for item in ui.state() if (item.get('AXUniqueId') or '').endswith(':meta:actions'))
    ui.axe('tap', '--id', actions, '--post-delay', '.6')
    ui.axe('tap', '--label', catalog.text('native.chat.message.copy'), '--post-delay', '.6')
    ui.axe('tap', '--id', identifier, '--post-delay', '.4')
    frame = ui.element(identifier)['frame']
    ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '.8')
    paste = ui.wait(lambda items: max((item for item in items if item.get('AXLabel') == catalog.system('paste')),
                                      key=lambda item: item['frame']['width'] * item['frame']['height'], default=None),
                    'Paste did not appear in the edit menu', timeout=5)['frame']
    ui.axe('tap', '-x', str(paste['x'] + paste['width'] / 2), '-y', str(paste['y'] + paste['height'] / 2), '--post-delay', '.8')
    label = catalog.text('native.chat.attachment.preview', name='Text.md')
    ui.wait(lambda items: any(item.get('AXLabel') == label for item in items), 'A copied long reply must paste as Text.md')
    ui.capture('reply-pasted')
print('PASS: HTML pastes as formatted nodes; copied replies keep their Markdown')
