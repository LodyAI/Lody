"""Rotation and width changes keep the open session and the sheet over it."""
import sys

from driver import UI
import catalog
import pad
from rotation import restore_portrait, rotate, set_width

ui = UI(sys.argv[1], sys.argv[2])
settings_close = catalog.text('accessibility.closeSheet', title=catalog.text('tabs.settings'))
close_activity = catalog.text('accessibility.closeSheet', title=catalog.text('process.title'))


def labeled(label):
    return ui.wait(lambda items: next((item for item in items if item.get('AXLabel') == label), None), f'Missing {label}')


def tap(frame):
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2),
           '--tap-style', 'physical', '--post-delay', '.8')


def chat_title():
    return ui.element('chat-navigation-title').get('AXLabel')


def open_settings():
    pad.show_list(ui)
    tap(labeled(catalog.text('tabs.settings'))['frame'])
    ui.element('account')


def close_settings():
    ui.axe('tap', '--label', settings_close, '--tap-style', 'physical', '--post-delay', '1')
    ui.wait(lambda items: not any(item.get('AXUniqueId') == 'account' for item in items) or None,
            'Settings did not close')


def session_kept(name):
    ui.element('session-input')
    assert chat_title() == title, ('The open session changed', name, chat_title(), title)
    assert ui.element('session-input').get('AXValue') == draft, ('The draft changed', name)
    ui.capture(f'{name}-session')


def change_with_sheet(name, change):
    open_settings()
    change()
    ui.element('account')
    ui.capture(f'{name}-sheet')
    close_settings()
    session_kept(name)


restore_portrait(ui)
pad.show_list(ui)
if not any(item.get('AXUniqueId') == 'ui-design' for item in ui.state()):
    tap(max((item['frame'] for item in ui.state() if item.get('AXUniqueId') == 'toggle:ui:local:lody'),
            key=lambda value: value['width'] * value['height']))
ui.axe('tap', '--id', 'ui-design', '--tap-style', 'physical', '--post-delay', '.8')
ui.element('session-input')
title = chat_title()
assert title, 'The session title is missing'
draft = 'Keep this draft through layout changes'
ui.axe('tap', '--id', 'session-input')
ui.type_into('session-input', draft)
# iPad's keyboard dismissal preserves focus and the composer draft.
tap(labeled('Hide keyboard')['frame'])
ui.capture('portrait-session')

try:
    change_with_sheet('landscape', lambda: rotate(ui, 'landscape'))
    change_with_sheet('portrait', lambda: rotate(ui, 'portrait'))

    change_with_sheet('compact', lambda: set_width(ui, 'compact'))
    ui.element('BackButton')
    assert not pad.list_visible(ui.state()), 'The compact width still shows the split list'
    tap(ui.element('a1:process')['frame'])
    labeled(close_activity)
    ui.capture('compact-activity')

    set_width(ui, 'regular')
    labeled(close_activity)
    labeled(catalog.system('showSidebar'))
    ui.capture('regular-activity')
    ui.axe('tap', '--label', close_activity, '--tap-style', 'physical', '--post-delay', '1')
    ui.wait(lambda items: not any(item.get('AXLabel') == close_activity for item in items) or None,
            'Activity did not close')
    session_kept('regular')
finally:
    set_width(ui, 'system')
    restore_portrait(ui)

print('PASS: Rotation and compact/regular width changes keep the open session and the sheet over it, both ways.')
