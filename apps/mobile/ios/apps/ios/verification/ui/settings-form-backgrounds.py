"""Only inspect Settings form surfaces, before and after keyboard expansion."""
import sys
from driver import UI
from sheet_background import capture_card
import catalog

ui = UI(sys.argv[1], sys.argv[2])
forms = {
    'machine': ['setting-name'],
    'agent': ['setting-name', 'setting-prompt'],
    'mcp': ['setting-name'],
    'workspace': ['workspace-name'],
}

for form, fields in forms.items():
    ui.axe('tap', '--id', f'form-{form}', '--post-delay', '.6')
    for field in fields:
        ui.element(field)
        capture_card(ui, f'{form}-{field}', field)
    ui.axe('tap', '--id', fields[0], '--post-delay', '.6')
    ui.wait(lambda items: any((item.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar')
                             and item['frame']['y'] < items[0]['frame']['height'] - 150
                             for item in items),
            f'{form}: keyboard did not expand')
    capture_card(ui, f'{form}-keyboard', fields[0], inset='trailing' if form == 'workspace' else 'leading')
    ui.axe('tap', '--label', catalog.text('common.cancel'), '--post-delay', '.5')
    ui.wait(lambda items: not any(item.get('AXUniqueId') == fields[0] for item in items),
            f'{form}: editor did not dismiss')

print('PASS: machine, Agent, MCP and workspace forms retain distinct cards with and without the keyboard; no saves or service actions.')
