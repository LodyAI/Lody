"""Production copy for assertions, read from the same catalog the app ships."""
import json
import os
import re
from pathlib import Path

LANGUAGE = os.environ.get('LODY_UI_LANGUAGE', 'en')
CATALOG = json.loads(
    (Path(__file__).resolve().parents[4] / 'packages/LodyKit/Sources/LodyKit/Resources/Localizable.xcstrings').read_text()
)['strings']


def format_value(template, arguments):
    next_index = 0
    def replace(match):
        nonlocal next_index
        if match.group(2) == '%':
            return '%'
        if match.group(1):
            index = int(match.group(1)) - 1
        else:
            index = next_index
            next_index += 1
        return str(arguments[index])
    return re.sub(r'%(?:(\d+)\$)?(@|lld|ld|d|%)', replace, template)


def text(key, **variables):
    entry = CATALOG[key]
    template = entry['localizations'][LANGUAGE]['stringUnit']['value']
    if not variables:
        return template
    names = [argument.split(': ', 1)[1] for argument in entry['comment'].split('; ')]
    return format_value(template, [variables[name] for name in names])


def workspace_switch(name, count=2, total=3):
    return f"{text('inbox.workspaceSwitch.accessibility', name=name)}, {text('devices.summary', count=count, total=total)}"


def plural(key, count, **variables):
    category = 'one' if LANGUAGE == 'en' and count == 1 else 'other'
    template = CATALOG[key]['localizations'][LANGUAGE]['variations']['plural'][category]['stringUnit']['value']
    return format_value(template, [count])


# UIKit's own controls follow the same App Language; these are not app copy.
SYSTEM = {
    'en': {'clear': 'Clear text', 'close': 'Close', 'cancel': 'Cancel', 'ok': 'OK', 'copy': 'copy', 'paste': 'Paste', 'nextKeyboard': 'Next keyboard', 'collapse': 'Collapse content'},
    'zh-Hans': {'clear': '清除文本', 'close': '关闭', 'cancel': '取消', 'ok': '好', 'copy': '拷贝', 'paste': '粘贴', 'nextKeyboard': '下一个键盘', 'collapse': '折叠内容'},
}


def system(name):
    return SYSTEM[LANGUAGE][name]


SYSTEM['en'].update(showSidebar='Show Sidebar', hideSidebar='Hide Sidebar')
SYSTEM['zh-Hans'].update(showSidebar='显示边栏', hideSidebar='隐藏边栏')
