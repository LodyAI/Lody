"""Interactive HTML, original-path resources and actionable feedback in both file hosts."""
import json
import subprocess
import sys
from pathlib import Path
from driver import UI

ui = UI(*sys.argv[1:])
container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
probe_path = Path(container) / 'tmp/lody-html-preview.json'

def probe():
    return json.loads(probe_path.read_text()) if probe_path.exists() else {}

def fixture(label):
    probe_path.unlink(missing_ok=True)
    ui.axe('tap', '--label', 'HTML Fixtures', '--post-delay', '.3')
    item = ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == label and i.get('role') == 'AXButton'), None), 'Fixture menu did not show: ' + label)
    frame = item['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.3')
    ui.wait(lambda items: not any(i.get('AXLabel') == label for i in items), 'Fixture menu did not close: ' + label)

def heading(label):
    return ui.wait(lambda _: probe().get('heading') == label, 'HTML did not show: ' + label)

def button(label):
    state = probe()
    control = next(item for item in state['controls'] if item['label'] == label)
    ui.axe('tap', '-x', str(state['originX'] + control['x'] + control['width'] / 2),
           '-y', str(state['originY'] + control['y'] + control['height'] / 2), '--post-delay', '.2')

def close_file():
    ui.axe('tap', '--id', 'file-back', '--post-delay', '.3')
    ui.element('file-links:answer')

def readable_heading(name):
    state = probe()
    items = ui.state()
    width = round(items[0]['frame']['width'])
    pixels = subprocess.check_output([
        'ffmpeg', '-v', 'error', '-i', str(ui.output / (name + '.png')),
        '-vf', f'scale={width}:-1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], timeout=20)
    def contrast(left, top, right, bottom):
        light = dark = count = 0
        for y in range(round(top), round(bottom)):
            for x in range(round(left), round(right)):
                value = sum(pixels[(y * width + x) * 3:(y * width + x) * 3 + 3]) / 3
                light += value > 230
                dark += value < 60
                count += 1
        return min(light, dark) > count * .01
    assert contrast(state['originX'] + 28, state['originY'], width - 28,
                    state['originY'] + state['controls'][0]['y'] - 8), 'The HTML heading has no visible contrast against the page background'
    # UIKit exposes the covered diff title too; the presented file is the last heading.
    title = [item['frame'] for item in items if item.get('role') == 'AXHeading' and item.get('AXLabel') == 'interactive.html'][-1]
    assert contrast(title['x'], title['y'], title['x'] + title['width'], title['y'] + title['height']), 'The native title has no visible contrast against its background'

def interactive(prefix):
    heading('First page')
    ui.capture(prefix + '-first-page')
    readable_heading(prefix + '-first-page')
    assert probe()['styled'], 'The relative stylesheet did not apply'
    button('Next page')
    heading('Second page')
    ui.capture(prefix + '-second-page')
    readable_heading(prefix + '-second-page')
    assert not any(i.get('AXUniqueId') == 'html-issues-summary' for i in ui.state()), 'Healthy relative resources were reported as failures'

fixture('HTML source')
ui.element('file-source')
toggle = ui.element('file-preview-toggle')
assert toggle['AXLabel'] == 'Preview', toggle
ui.capture('file-source')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.3')
interactive('file')
assert ui.element('file-preview-toggle')['AXLabel'] == 'Source'
button('Load missing resource')
summary = ui.element('html-issues-summary')
assert summary['AXLabel'] == '1 resource did not load', summary
ui.capture('dynamic-resource-failure')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.3')
ui.element('file-source')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.3')
heading('First page')
assert not any(i.get('AXUniqueId') == 'html-issues-summary' for i in ui.state()), 'Reopening preview kept stale errors'
close_file()

fixture('HTML diff')
ui.wait(lambda items: any(i.get('AXLabel') == 'Preview' for i in items), 'Direct HTML preview button missing')
ui.axe('tap', '--label', 'Preview', '--post-delay', '.3')
interactive('diff')
ui.axe('tap', '--id', 'file-back', '--post-delay', '.3')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.3')
ui.element('file-links:answer')

fixture('HTML resource failures')
heading('First page')
summary = ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == 'html-issues-summary' and i.get('AXLabel') == '4 resources did not load'), None), 'Missing local resources were not reported separately')
ui.capture('partial-preview')
ui.axe('tap', '--id', 'html-issues-summary', '--post-delay', '.3')
ui.element('html-issue-0')
send = ui.element('html-feedback-send')
assert send['frame']['height'] >= 44 and send['frame']['width'] >= 44, send
ui.capture('resource-details')
ui.axe('tap', '--id', 'html-feedback-send', '--post-delay', '.3')
status = ui.element('html-feedback-status')
assert status['AXLabel'] == 'Feedback sent', status
ui.capture('feedback-sent')
assert not any(i.get('AXUniqueId') == 'html-feedback-send' for i in ui.state()), 'Feedback can be sent twice'
ui.axe('tap', '--id', 'html-issues-close', '--post-delay', '.3')
close_file()
report = ui.element('html-feedback-report')['AXLabel']
diagnostic = json.loads(report[report.index('{'):])
assert diagnostic['file'] == 'docs/broken.html', diagnostic
issues = diagnostic['issues']
assert {i['code'] for i in issues} == {'file_not_found', 'root_path_unavailable', 'local_file_unavailable', 'local_service_unavailable'}, issues
assert any(i['reference'] == './assets/missing.svg' and i['path'] == 'docs/assets/missing.svg' for i in issues), issues
assert 'token=' not in report and 'lody-preview://' not in report, report
(ui.output / 'feedback-request.json').write_text(json.dumps(diagnostic, indent=2))

for label, element, expected, capture in [
    ('HTML feedback failure', 'html-feedback-error', 'Feedback could not be sent.', 'feedback-failed'),
    ('HTML queued feedback', 'html-feedback-status', 'Feedback saved and queued', 'feedback-queued'),
]:
    fixture(label)
    ui.element('html-issues-summary')
    ui.axe('tap', '--id', 'html-issues-summary', '--post-delay', '.3')
    ui.axe('tap', '--id', 'html-feedback-send', '--post-delay', '.3')
    assert expected in ui.element(element)['AXLabel']
    ui.capture(capture)
    ui.axe('tap', '--id', 'html-issues-close', '--post-delay', '.3')
    close_file()

print('PASS: source/diff hosts run HTML interactions and relative CSS/JS; dynamic failures reset; local paths/services produce actionable, redacted feedback; sent/failed/queued states stay distinct')
