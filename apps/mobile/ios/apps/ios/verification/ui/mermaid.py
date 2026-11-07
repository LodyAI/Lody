"""Native Mermaid diagrams retain source, fall back safely and render in both hosts."""
import subprocess
import sys
import json
from pathlib import Path
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
probe = Path(container) / 'tmp/lody-mermaid.json'
expected_source = 'graph TD\n    A[Start] --> B{Ready?}\n    B -->|Yes| C[Done]\n    B -->|No| A'
owner = 'mermaid-preview:text'

def diagrams():
    if not probe.exists():
        return None
    return [item for item in json.loads(probe.read_text()) if item['owner'] == owner]

def fixture(name):
    global expected_source, owner
    previous = ui.element(owner)['AXLabel']
    ui.axe('tap', '--label', 'Diagram fixtures', '--post-delay', '.2')
    ui.wait(lambda items: any(i.get('AXLabel') == name and i.get('frame', {}).get('height', 0) > 0 for i in items), f'{name} fixture menu did not open')
    ui.axe('tap', '--label', name, '--post-delay', '.2')
    owner = 'mermaid-preview:plan' if name == 'Plan' else 'mermaid-preview:text'
    def updated(items):
        row = next((i for i in items if i.get('AXUniqueId') == owner), None)
        return row if row and row.get('AXLabel') != previous else None
    row = ui.wait(updated, f'{name} fixture did not reach the transcript')
    text = row['AXLabel'].split('Before the diagram.', 1)[1].split('After the diagram.', 1)[0].strip()
    expected_source = text.removeprefix('```mermaid\n').removesuffix('```').strip()

def diagram():
    def ready(_):
        items = diagrams()
        return items if items and items[0]['source'].strip() == expected_source else None
    items = ui.wait(ready, 'Native diagram was not placed')
    assert len(items) == 1, items
    frame = items[0]
    assert 0 < frame['width'] <= 410 and frame['height'] > 30, frame
    return frame

def copy_diagram():
    frame = diagram()
    subprocess.run(['xcrun', 'simctl', 'pbcopy', ui.udid], input='Mermaid copy pending', text=True, check=True)
    ui.axe('touch', '-x', str(frame['x'] + frame['width'] / 2),
           '-y', str(frame['y'] + frame['height'] / 2), '--down', '--up', '--delay', '1')
    action = ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == catalog.text('native.chat.copy') and i.get('frame', {}).get('height', 0) > 0), None), 'Diagram has no visible copy action')
    ui.capture('copy-menu-' + owner)
    frame = action['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.2')
    def copied(_):
        value = subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True)
        return value if value.strip() == expected_source else None
    value = ui.wait(copied, 'Diagram source did not reach the clipboard')
    (ui.output / f'clipboard-{owner}.txt').write_text(value)
    return value

first = diagram()
assert 'Start' in first['source'] and 'Done' in first['source']
ui.capture('chat-flowchart')
assert copy_diagram() == 'graph TD\n    A[Start] --> B{Ready?}\n    B -->|Yes| C[Done]\n    B -->|No| A\n'
ui.capture('copied-source')

for name in ['Sequence', 'State', 'Class', 'ER', 'XY', 'Chinese']:
    fixture(name)
    diagram()
    ui.capture(name.lower())

fixture('Plan')
diagram()
assert ui.element(owner)['frame']['height'] == 240
ui.capture('plan-collapsed')
ui.axe('tap', '--label', catalog.text('native.chat.proposedPlan.expand'), '--post-delay', '.2')
ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == owner and i['frame']['height'] > 240), None), 'Plan diagram did not expand')
diagram()
ui.capture('plan-expanded')

for name in ['Invalid', 'Unsupported', 'Oversized', 'Streaming']:
    fixture(name)
    ui.wait(lambda _: diagrams() == [], f'{name} must retain the code block')
    ui.element('mermaid-preview:text')
    ui.capture(name.lower() + '-source')

# The same message identity transitions from in-flight source to completed diagram.
fixture('Flowchart')
diagram()
ui.capture('stream-completed')
ui.axe('tap', '--label', 'Document', '--post-delay', '.4')
ui.element('file-document-content')
owner = 'file-document-content'
diagram()
ui.capture('document-flowchart')
assert copy_diagram().startswith('graph TD\n    A[Start] --> B{Ready?}')
ui.capture('document-copied-source')
appearance = subprocess.check_output(['xcrun', 'simctl', 'ui', ui.udid, 'appearance'], text=True).strip()
other = 'dark' if appearance == 'light' else 'light'
subprocess.run(['xcrun', 'simctl', 'ui', ui.udid, 'appearance', other], check=True)
diagram()
ui.capture('document-live-' + other)
subprocess.run(['xcrun', 'simctl', 'ui', ui.udid, 'appearance', appearance], check=True)
print('PASS: six diagram types, Chinese labels, exact source copy, plan expansion, invalid/unsupported/oversized fallback, streaming completion and Markdown document')
