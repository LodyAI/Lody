"""Inline alerts expose separate details/retry actions and preserve the composer."""
import json
import subprocess
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
def tap(identifier):
    ui.axe('tap', '--tap-style', 'physical', '--post-delay', '0.4', '--id', identifier)
def close():
    ui.axe('tap', '--tap-style', 'physical', '--post-delay', '0.5', '--label',
           catalog.text('accessibility.closeSheet', title=catalog.text('native.chat.error.detail')))
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'agent-error-report' for i in items), 'Error sheet did not dismiss')
def label(identifier):
    return ui.element(identifier).get('AXLabel')

for entry, title in [('error-system', 'acp_provider_overloaded'), ('error-assistant', 'unknown'), ('error-missing', 'unknown')]:
    assert label(entry + ':failure:title') == catalog.text('native.chat.error.' + title)
ui.element('error-assistant:text')
state = ui.state()
assert not any(i.get('AXUniqueId') in ['error-assistant:failure:retry', 'error-missing:failure:retry', 'error-missing:failure:details'] for i in state)
assert ui.element('error-system:failure:retry')['frame']['height'] >= 44
assert ui.element('error-system:failure:details')['frame']['height'] >= 44
# Short descriptions should not reserve a second line or a separated action band.
short_title = ui.element('error-assistant:failure:title')['frame']
short_action = ui.element('error-assistant:failure:details')['frame']
assert short_action['y'] + short_action['height'] - short_title['y'] < 100
retry_frame = ui.element('error-system:failure:retry')['frame']
details_frame = ui.element('error-system:failure:details')['frame']
assert details_frame['x'] - (retry_frame['x'] + retry_frame['width']) <= 22
ui.capture('cards')
# The title has no action; only the explicitly named controls can open a sheet.
tap('error-system:failure:title')
assert not any(i.get('AXUniqueId') == 'agent-error-report' for i in ui.state())
tap('error-system:failure:details')
report = label('agent-error-report')
assert 'fixture-429' in report and 'acp_provider_overloaded' in report
ui.capture('details')
tap('agent-error-copy')
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('native.chat.error.copied') for i in items), 'Copy confirmation missing')
assert subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True) == report
ui.capture('copied')
close()
tap('error-assistant:failure:details')
unknown = label('agent-error-report')
assert 'future_reason' in unknown and 'future_code' in unknown
ui.capture('unknown-details')
close()

frame = ui.element('error-system:failure:retry')['frame']
draft = ui.element('session-input').get('AXValue')
tap('error-system:failure:retry')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'error-system:failure:retry' and i.get('AXLabel') == catalog.text('native.chat.error.retrying') for i in items), 'Retry spinner did not appear')
assert ui.element('error-system:failure:retry')['frame'] == frame
ui.capture('retry-pending')
ui.axe('tap', '--tap-style', 'physical', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + 22))
ui.wait(lambda items: any(i.get('AXLabel') == catalog.text('native.chat.error.retryFailed') for i in items), 'Definite rejection did not return a retry action')
assert label('error-retry-count') == '1'
assert ui.element('error-system:failure:retry')['frame']['height'] == 44
ui.capture('retry-failed')
payload = json.loads(label('error-retry-payload'))
assert payload['attachments'] == [] and payload['queue'] is False
assert payload['text'] == 'Continue working from where you left off. The previous turn stopped because the selected model was at capacity.'
first_id = payload['id']
tap('error-system:failure:retry')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'error-system:failure:retry' for i in items), 'Accepted retry stayed actionable')
assert label('error-retry-count') == '2'
assert json.loads(label('error-retry-payload'))['id'] != first_id
assert ui.element('session-input').get('AXValue') == draft == 'Keep this draft'
ui.element('error-system:failure:title')
ui.capture('retry-accepted')
print('PASS: inline card, independent details, single dispatch, explicit retry, stable layout and retained draft')
