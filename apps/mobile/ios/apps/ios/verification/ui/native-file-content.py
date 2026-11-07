"""Native file content: Markdown/source toggle, relative links, target line, errors, interactive HTML and resource feedback."""
import json
import subprocess
import sys
from pathlib import Path
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
container = subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip()
source_probe = Path(container) / 'tmp/lody-file-source.json'
html_probe = Path(container) / 'tmp/lody-html-preview.json'

def geometry(name):
    value = json.loads(source_probe.read_text())
    (ui.output / (name + '.probe.json')).write_text(json.dumps(value, indent=2))
    return value

def html():
    return json.loads(html_probe.read_text()) if html_probe.exists() else {}

def title(name):
    return ui.wait(lambda items: any(i.get('type') == 'Heading' and i.get('AXLabel') == name for i in items), 'Wrong file opened: ' + name)

def open_fixture(row):
    source_probe.unlink(missing_ok=True)
    html_probe.unlink(missing_ok=True)
    ui.axe('tap', '--id', row, '--post-delay', '.5')

def close():
    buttons = [i for i in ui.state() if i.get('AXUniqueId') == 'file-back']
    assert buttons and str(buttons[-1].get('AXLabel') or '').casefold() == catalog.text('native.close').casefold(), buttons
    frame = buttons[-1]['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.6')

def heading(label):
    return ui.wait(lambda _: html().get('heading') == label, 'HTML did not show: ' + label)

def button(label):
    state = html()
    control = next(item for item in state['controls'] if item['label'] == label)
    ui.axe('tap', '-x', str(state['originX'] + control['x'] + control['width'] / 2),
           '-y', str(state['originY'] + control['y'] + control['height'] / 2), '--post-delay', '.2')

def visible_target(value):
    return value['highlighted'] and value['top'] < value['targetY'] < value['bottom'] - value['targetHeight']

open_fixture('file:report.md')
title('report.md')
ui.element('file-document')
ui.wait(lambda items: any('Performance report' in (i.get('AXLabel') or '') for i in items), 'Markdown content missing')
ui.capture('markdown')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.4')
ui.element('file-source')
ui.wait(lambda _: source_probe.exists() and geometry('markdown-source')['sourceMatches'], 'Markdown source did not render')
ui.capture('markdown-source')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.4')
document = ui.element('file-document-content')['frame']
source_probe.unlink(missing_ok=True)
ui.axe('tap', '-x', str(document['x'] + 60), '-y', str(document['y'] + document['height'] - 10), '--post-delay', '.6')
title('sample.swift')
ui.element('file-source')
ui.wait(lambda _: source_probe.exists() and geometry('relative-link').get('line') == 2, 'Relative link did not open line 2')
assert visible_target(geometry('relative-link')), geometry('relative-link')
ui.capture('relative-file')
close()
title('report.md')
close()
ui.element('file:report.md')

open_fixture('file:sample.swift')
title('sample.swift')
ui.element('file-source')
ui.wait(lambda _: source_probe.exists() and geometry('code-target').get('line') == 120 and geometry('code-target')['coloredTokens'] > 0, 'Target code did not render')
initial = geometry('code-target')
assert initial['sourceMatches'] and visible_target(initial), initial
assert initial['contentWidth'] > initial['width'] * 2, initial
ui.capture('code')
ui.axe('drag', '--start-x', '330', '--start-y', '440', '--end-x', '100', '--end-y', '440', '--duration', '.5', '--post-delay', '.6')
ui.wait(lambda _: geometry('code-horizontal')['x'] > initial['x'] + 80, 'Source did not scroll horizontally')
ui.axe('drag', '--start-x', '220', '--start-y', '650', '--end-x', '220', '--end-y', '300', '--duration', '.5', '--post-delay', '.6')
ui.wait(lambda _: geometry('code-vertical')['y'] > initial['y'] + 100, 'Source did not scroll vertically')
ui.capture('code-scrolled')
close()

open_fixture('file:missing.txt')
ui.wait(lambda items: any(catalog.text('native.file.error.notFound') in str(i.get('AXLabel') or '') for i in items), 'Missing-file error was swallowed')
ui.capture('missing-file')
ui.axe('tap', '--label', catalog.text('common.retry'), '--post-delay', '.1')
ui.wait(lambda items: any(catalog.text('native.file.error.notFound') in str(i.get('AXLabel') or '') for i in items), 'Retry lost the missing-file error')
close()
open_fixture('file:rpc-error.md')
ui.wait(lambda items: any(catalog.text('native.file.error.read') in str(i.get('AXLabel') or '') for i in items), 'RPC rejection must show a read failure')
assert not any(catalog.text('native.file.error.offline') in str(i.get('AXLabel') or '') for i in ui.state()), 'RPC rejection was mislabeled as offline'
ui.capture('rpc-read-failure')
close()

open_fixture('html:source')
ui.element('file-source')
toggle = ui.element('file-preview-toggle')
assert toggle['AXLabel'] == catalog.text('file.preview'), toggle
ui.capture('html-source')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.3')
heading('First page')
assert html()['styled'], 'The relative stylesheet did not apply'
button('Next page')
heading('Second page')
ui.capture('html-second-page')
button('Load missing resource')
summary = ui.element('html-issues-summary')
assert summary['AXLabel'] == '1 resource did not load', summary
ui.capture('dynamic-resource-failure')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.3')
ui.element('file-source')
ui.axe('tap', '--id', 'file-preview-toggle', '--post-delay', '.3')
heading('First page')
assert not any(i.get('AXUniqueId') == 'html-issues-summary' for i in ui.state()), 'Reopening preview kept stale errors'
close()

open_fixture('html:diff')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('file.preview') for i in items), 'Direct HTML preview button missing')
ui.axe('tap', '--label', catalog.text('file.preview'), '--post-delay', '.3')
heading('First page')
ui.capture('diff-html-preview')
close()
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.5')
ui.element('html:diff')

open_fixture('html:failures')
heading('First page')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'html-issues-summary' and i.get('AXLabel') == '4 resources did not load' for i in items), 'Missing local resources were not reported separately')
ui.capture('partial-preview')
ui.axe('tap', '--id', 'html-issues-summary', '--post-delay', '.5')
ui.element('html-issue-0')
send = ui.element('html-feedback-send')
assert send['frame']['height'] >= 44 and send['frame']['width'] >= 44, send
ui.capture('resource-details')
ui.axe('tap', '--id', 'html-feedback-send', '--post-delay', '.3')
assert ui.element('html-feedback-status')['AXLabel'] == catalog.text('html.feedback.sent')
ui.capture('feedback-sent')
assert not any(i.get('AXUniqueId') == 'html-feedback-send' for i in ui.state()), 'Feedback can be sent twice'
ui.axe('tap', '--id', 'html-issues-close', '--post-delay', '.5')
close()
report = ui.element('html-feedback-report')['AXLabel']
diagnostic = json.loads(report[report.index('{'):])
assert diagnostic['file'] == 'docs/broken.html', diagnostic
codes = {i['code'] for i in diagnostic['issues']}
assert codes == {'file_not_found', 'root_path_unavailable', 'local_file_unavailable', 'local_service_unavailable'}, codes
assert any(i['reference'] == './assets/missing.svg' and i['path'] == 'docs/assets/missing.svg' for i in diagnostic['issues']), diagnostic
assert 'token=' not in report and 'lody-preview://' not in report, report
(ui.output / 'feedback-request.json').write_text(json.dumps(diagnostic, indent=2))

for row, element, expected, capture in [
    ('html:feedback-failure', 'html-feedback-error', catalog.text('html.feedback.failed'), 'feedback-failed'),
    ('html:queued', 'html-feedback-status', catalog.text('html.feedback.queued'), 'feedback-queued'),
]:
    open_fixture(row)
    ui.element('html-issues-summary')
    ui.axe('tap', '--id', 'html-issues-summary', '--post-delay', '.5')
    ui.axe('tap', '--id', 'html-feedback-send', '--post-delay', '.3')
    assert ui.element(element)['AXLabel'] == expected
    ui.capture(capture)
    ui.axe('tap', '--id', 'html-issues-close', '--post-delay', '.5')
    close()
print('PASS: native Markdown/source, relative link, target line in both scroll axes, errors and retry, interactive HTML from file and diff hosts, redacted feedback with sent/failed/queued states')
