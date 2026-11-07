"""Markdown shortcuts format in place, send as Markdown, and survive a rejected send."""
import json
import time
import sys
from driver import UI

ui = UI(*sys.argv[1:])


def sent():
    return json.loads(ui.element('composer-sent')['AXLabel'])


def value():
    return ui.element('create-session-input').get('AXValue') or ''


ui.axe('tap', '--id', 'create-session-input', '--post-delay', '.6')
for _ in range(len(value()) + 4):
    ui.axe('key', '42')
ui.wait(lambda items: not value(), 'Could not clear the fixture draft')
ui.axe('type', '# title')
ui.wait(lambda items: value().lower() == 'title', f'Heading shortcut left its tag in the input: {value()!r}')
ui.capture('heading')
for _ in range(len(value()) + 2):
    ui.axe('key', '42')
ui.wait(lambda items: not value(), 'Could not clear the heading')
ui.axe('type', '**bold** and `code` ')
ui.wait(lambda items: value().rstrip() == 'bold and code', 'Shortcuts left their Markdown tags in the input')
ui.capture('formatted')
ui.axe('tap', '--id', 'session-send', '--post-delay', '.8')
assert sent().rstrip() == '**bold** and `code`', f'Sent body was not Markdown: {sent()!r}'
assert not value(), 'Pending draft must clear'
ui.axe('tap', '--id', 'complete-request', '--post-delay', '1')
ui.wait(lambda items: value().rstrip() == 'bold and code', 'Rejected send did not restore the draft')
ui.capture('restored')
ui.axe('tap', '--id', 'create-session-input', '--post-delay', '.6')
ui.axe('key-combo', '--modifiers', '227', '--key', '4')
ui.axe('key-combo', '--modifiers', '227', '--key', '6')
ui.axe('key', '79')
ui.axe('key-combo', '--modifiers', '227', '--key', '25')
for _ in range(20):
    if value().count('bold and code') == 2:
        break
    if any(item.get('AXLabel') == 'Allow Paste' for item in ui.state()):
        ui.axe('tap', '--label', 'Allow Paste', '--post-delay', '.5')
    time.sleep(.3)
ui.wait(lambda items: value().count('bold and code') == 2, f'Copied composer text did not paste back as text: {value()!r}')
ui.capture('pasted')
print('PASS: in-place shortcuts, Markdown send body, formatted restore after rejection and copy/paste as text')
