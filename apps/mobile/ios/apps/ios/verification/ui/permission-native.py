"""Native session permission lifecycle and retained question answers, without JS probes."""
import json
import sys
import time
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
started = time.monotonic()


def checkpoint(name):
    print(f'{name}: {time.monotonic() - started:.2f}s', flush=True)


def wait_text(text):
    return ui.wait(lambda items: any(text in (i.get('AXLabel') or '') for i in items), f'Missing {text}')


def fixture(action):
    ui.axe('tap', '--label', 'Fixtures')
    wait_text(action)
    ui.axe('tap', '--label', action)


def fresh():
    ui.open_case('permission-native-preview')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'permission-preview-probe' and not i.get('AXValue') for i in items),
            'Fresh permission session did not appear')


def gone():
    ui.wait(lambda items: not any(i.get('AXLabel') == 'Allow once' for i in items), 'Permission remained open')
    ui.element('permission-preview-probe')


assert not any(i.get('AXLabel') == catalog.text('native.chat.error.transcript') for i in ui.state()), 'Fixture transcript must decode successfully'
ui.type_into('session-input', '12345')
fixture('Permission request')
wait_text('Allow once')
wait_text('Custom choice')
ui.capture('pending')
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=catalog.text('permission.title')))
gone()
assert ui.element('session-input').get('AXValue') == '12345', 'Closing permission lost the draft'
fixture('Permission request')
ui.wait(lambda items: 'request:2' in (next((i.get('AXValue') for i in items if i.get('AXUniqueId') == 'permission-preview-probe'), '') or ''),
        'Second request never reached the transcript')
assert not any(i.get('AXLabel') == 'Allow once' for i in ui.state()), 'Manual close must suppress auto-open during this visit'
ui.capture('manual-close')
ui.axe('tap', '--id', 'entry:process')
row = ui.wait(lambda items: next((i for i in items if 'Run checks 2' in (i.get('AXLabel') or '')), None), 'Pending process row missing')
# AX includes the presenting session behind this sheet; only its retained composer may remain.
inputs = [i for i in ui.state() if i.get('AXUniqueId') == 'session-input']
assert len(inputs) == 1 and inputs[0].get('AXValue') == '12345', 'Read-only process page exposed a composer'
ui.capture('process')
frame = row['frame']
ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2))
wait_text('Allow once')
ui.capture('manual-reopen')
ui.axe('tap', '--label', 'Allow once')
close_process = catalog.text('accessibility.closeSheet', title=catalog.text('process.title'))
wait_text(close_process)
wait_text(catalog.text('process.empty'))
ui.axe('tap', '--label', close_process)
gone()
assert ui.element('session-input').get('AXValue') == '12345', 'Nested permission lost the draft'
checkpoint('manual close and nested reopen')

fresh()
fixture('Permission request')
wait_text('Allow once')
ui.axe('tap', '--label', 'Allow once')
gone()
fixture('Permission request')
wait_text('Run checks 2')
wait_text('Allow once')
ui.capture('next-request')
ui.axe('tap', '--label', 'Custom choice')
gone()

fresh()
fixture('Remote answer')
# The remote reply can arrive before a slow AX read samples the transient options.
# Verify its resolved projection and closed sheet; pending UI is checked above.
ui.wait(lambda items: any(i.get('AXUniqueId') == 'permission-preview-probe' and 'remote' in (i.get('AXValue') or '') for i in items),
        'Remote answer did not reach the session')
gone()
ui.capture('remote-answer')
fixture('Request replacement')
wait_text('Allow once')
ui.axe('tap', '--label', 'Allow once')
wait_text('Run checks 3')
wait_text('Allow once')
ui.capture('replacement')
checkpoint('successive, remote and replaced requests')
ui.axe('tap', '--label', 'Allow once')
gone()

fresh()
ui.type_into('session-input', '12345')
fixture('Question request')
ui.element('question-option-0')
ui.capture('single')
initial_y = ui.element('question-option-0')['frame']['y']
ui.axe('drag', '--start-x', '200', '--start-y', '420', '--end-x', '200', '--end-y', '80', '--duration', '.5', '--post-delay', '.6')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'question-option-0' and i['frame']['y'] < initial_y - 150 for i in items), 'Question sheet did not expand')
button = ui.element('question-next')['frame']
screen = next(i['frame']['height'] for i in ui.state() if i.get('type') == 'Application')
assert button['y'] + button['height'] <= screen - 30, 'Question action overlaps the home indicator'
ui.capture('full-height')
ui.axe('tap', '--id', 'question-option-0')
ui.axe('tap', '--id', 'question-next')
wait_text('Which checks should run?')
ui.axe('tap', '--id', 'question-option-0')
ui.axe('tap', '--id', 'question-option-1')
ui.capture('multiple')
ui.axe('tap', '--id', 'list-step-0')
wait_text('Which language should we use?')
ui.axe('tap', '--id', 'question-next')
ui.axe('tap', '--id', 'question-next')
wait_text('Anything else we should know?')
ui.axe('tap', '--id', 'question-custom')
wait_text(catalog.text('common.done'))
ui.axe('type', 'Keep it native')
# Assert retention of the actual keyboard input, including the simulator's Shift state.
note = ui.wait(lambda items: next((i.get('AXValue') for i in items if i.get('type') == 'TextField' and i.get('AXValue')), None),
               'Question text input is empty')
ui.axe('tap', '--label', catalog.text('common.done'))
wait_text(note)
ui.axe('tap', '--id', 'question-submit')
wait_text(catalog.text('permission.error.send'))
ui.capture('retry')
ui.axe('tap', '--id', 'question-submit')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'question-submit' for i in items), 'Retry did not close questions')
probe = ui.element('permission-preview-probe').get('AXValue') or ''
start = probe.index('{')
answers, _ = json.JSONDecoder().raw_decode(probe[start:])
assert answers == {'language': 'Swift', 'checks': ['Unit tests', 'UI tests'], 'notes': note}, answers
assert 'submit:request-1:2' in probe, probe
assert ui.element('session-input').get('AXValue') == '12345', 'Answering questions lost the draft'
ui.capture('answered')
checkpoint('question answers and retry')
ui.open_case('permission-native-waiting')
wait_text(catalog.text('permission.waiting'))
ui.capture('waiting')
wait_text('Allow once')
ui.axe('tap', '--label', 'Allow once')
gone()

checkpoint('waiting request')
print('PASS: manual dismissal gate, successive requests, remote answer, request replacement, multi-question answers and retry')
