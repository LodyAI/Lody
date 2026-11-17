"""Offline --ui-verify-home Schedules tab: production list and editor over the scripted ScheduleFixture."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def text(key, **variables):
    return catalog.text('schedules.' + key, **variables)


def labeled(label):
    return ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == label), None), f'Missing {label}')


def list_element(identifier, *, editor=False):
    # UIKit virtualizes rows, and a pause/resume can move the row between groups.
    # Search from the top, then drag until the whole target clears the tab bar.
    for attempt in range(10):
        items = ui.state()
        row = next((i for i in items if i.get('AXUniqueId') == identifier), None)
        if editor:
            screen = next(i for i in items if i.get('type') == 'Application')['frame']
            bottom = screen['y'] + screen['height'] - 40
        else:
            tab = next(i for i in items if i.get('AXUniqueId') == 'home-tab-schedules')['frame']
            bottom = tab['y'] - 24
        if row and row['frame']['y'] >= 120 and row['frame']['y'] + row['frame']['height'] <= bottom:
            return row
        down = (row and row['frame']['y'] < 120) or (not row and attempt < 2)
        start, end = (220, bottom - 20) if down else (bottom - 20, 220)
        ui.axe('drag', '--start-x', '200', '--start-y', str(start),
               '--end-x', '200', '--end-y', str(end), '--duration', '.4')
    raise AssertionError(f'Could not scroll to {identifier}')


def open_schedule(identifier):
    list_element(identifier)
    ui.axe('tap', '--id', identifier)


def row_text(identifier):
    row = list_element(identifier) if identifier.startswith('schedule:') else ui.element(identifier)
    return ' '.join(str(row.get(key) or '') for key in ('AXLabel', 'AXValue'))


def wait_row(identifier, fragment):
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier and fragment in ' '.join(str(i.get(k) or '') for k in ('AXLabel', 'AXValue'))
                              for i in items), f'{identifier} never showed {fragment}')


def back():
    button = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') == 'Back'), None), 'Missing native Back')
    f = button['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.8')
    ui.element('home-schedules-list')


def fixture_state(operation, expected):
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'schedule-fixture-' + operation
                             and i.get('AXValue') == expected for i in items),
            f'{operation} never reached fixture state {expected}')


def fixture(action, operation):
    ui.open_case(f'schedule-fixture-{action}-{operation}')
    fixture_state(operation, {'hold': 'armed', 'fail': 'failed', 'release': 'released'}[action])


def swipe_action(identifier, action):
    frame = list_element(identifier)['frame']
    y = frame['y'] + frame['height'] / 2
    ui.axe('drag', '--start-x', str(frame['x'] + frame['width'] - 12), '--start-y', str(y),
           '--end-x', str(frame['x'] + frame['width'] / 2), '--end-y', str(y), '--duration', '.6')
    button = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button'
                                       and i.get('AXLabel') == text(action)), None), f'Missing swipe {action}')
    f = button['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2))


ui.element('home-chat-list')
# Seed the real disk adapter before the first Schedules page exists. Distinct
# account/workspace snapshots must remain independent; the fixture reports ready
# only after reading each back through the production service.
ui.open_case('schedule-fixture-seed-cache')
fixture_state('cache', 'ready')
fixture('hold', 'list')
ui.axe('tap', '--id', 'home-tab-schedules')
ui.element('home-schedules-list')
fixture_state('list', 'pending')
wait_row('schedule:daily-review', 'Cached daily review')
assert not any('Other account review' in str(i) or 'Other workspace review' in str(i) for i in ui.state())
ui.capture('schedule-cached-list-pending')
fixture('fail', 'list')
wait_row('schedule:daily-review', 'Cached daily review')
ui.capture('schedule-cached-list-failed')
# Returning to the tab retries the live read and replaces the disk projection.
ui.axe('tap', '--id', 'home-tab-chats')
ui.element('home-chat-list')
ui.axe('tap', '--id', 'home-tab-schedules')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'schedule:daily-review'
                         and 'Daily review' in str(i.get('AXLabel'))
                         and 'Cached daily review' not in str(i.get('AXLabel')) for i in items),
        'Fresh list did not replace the cached row')
ui.element('workspace-menu')
ui.element('schedules-section:attention')
list_element('schedules-section:running')
list_element('schedule:nightly-build')
# Status in words; only the blocked task is tinted and names its reason.
assert text('state.blocked') in row_text('schedule:nightly-build')
assert text('paused') in row_text('schedule:weekly-digest')
assert text('status.manual') in row_text('schedule:release-check')
ui.capture('schedules-list')

# The tab bar's create action reads "+ New schedule" here.
create = ui.element('home-new-session')
assert create.get('AXLabel') == text('new'), create

# Hold replies at the service boundary. These assertions must pass before either
# the command or the reconciliation read can supply the expected row state.
for identifier, action, optimistic_paused in [
    ('schedule:daily-review', 'pause', True),
    ('schedule:weekly-digest', 'resume', False),
]:
    original = row_text(identifier)
    fixture('hold', 'command')
    fixture('hold', 'list')
    swipe_action(identifier, action)
    fixture_state('command', 'pending')
    list_element(identifier)
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier
                             and (text('paused') in ' '.join(str(i.get(k) or '') for k in ('AXLabel', 'AXValue'))) == optimistic_paused
                             for i in items), f'{action} did not update before its reply')
    ui.capture('schedule-' + action + '-pending')
    fixture('fail', 'command')
    fixture_state('list', 'pending')
    list_element(identifier)
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier
                             and ' '.join(str(i.get(k) or '') for k in ('AXLabel', 'AXValue')) == original
                             for i in items), f'{action} failure did not restore the original row')
    ui.capture('schedule-' + action + '-rollback')
    fixture('release', 'list')

# The pushed editor uses the same command boundary and must restore its action
# and the shared list cache after a failed optimistic change.
for identifier, action, preview_action in [
    ('schedule:daily-review', 'pause', 'resume'),
    ('schedule:weekly-digest', 'resume', 'pause'),
]:
    original = row_text(identifier)
    open_schedule(identifier)
    ui.element('schedule-prompt')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'schedule-pause-toggle'
                             and i.get('AXLabel') == text(action) and i.get('enabled')
                             for i in items), f'Editor {action} unavailable')
    fixture('hold', 'command')
    fixture('hold', 'list')
    ui.axe('tap', '--id', 'schedule-pause-toggle')
    fixture_state('command', 'pending')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'schedule-pause-toggle'
                             and i.get('AXLabel') == text(preview_action) and not i.get('enabled', True)
                             for i in items), f'Editor {action} did not preview and disable its action')
    ui.capture('schedule-editor-' + action + '-pending')
    fixture('fail', 'command')
    ui.wait(lambda items: any(i.get('AXUniqueId') == 'schedule-pause-toggle'
                             and i.get('AXLabel') == text(action) and i.get('enabled')
                             for i in items), f'Editor {action} did not roll back')
    wait_row('schedule-error', text('error.schedule_conflict'))
    fixture_state('list', 'pending')
    ui.capture('schedule-editor-' + action + '-rollback')
    back()
    assert row_text(identifier) == original, 'Editor rollback did not restore shared list cache'
    fixture('release', 'list')

# Swipe a timed task: Pause (and Delete) only, never a full-swipe commit.
swipe_action('schedule:daily-review', 'pause')
list_element('schedule:daily-review')
wait_row('schedule:daily-review', text('paused'))

# Cached owned detail is useful immediately but cannot authorize overwriting a
# remote edit until the fresh detail has validated this instance's baseline.
open_schedule('schedule:daily-review')
ui.element('schedule-prompt')
ui.wait(lambda items: any(i.get('AXLabel') == text('save') and i.get('enabled') for i in items),
        'Fresh owned detail never enabled Save')
cached_prompt = row_text('schedule-prompt')
back()
fixture('hold', 'detail')
open_schedule('schedule:daily-review')
fixture_state('detail', 'pending')
assert row_text('schedule-prompt') == cached_prompt
assert not labeled(text('save')).get('enabled', True), 'Cached detail must not authorize Save'
ui.capture('schedule-cached-owned-unvalidated')
fixture('release', 'detail')
ui.wait(lambda items: any(i.get('AXLabel') == text('save') and i.get('enabled') for i in items),
        'Fresh detail did not enable Save')
ui.capture('schedule-cached-owned-validated')
back()

# A rule the menu cannot name stays read only with Replace.
open_schedule('schedule:legacy-cron')
ui.element('schedule-replace')
ui.element('schedule-name')
ui.capture('schedule-unsupported')
back()

# A teammate's schedule is read only: no Save, no More menu.
open_schedule('schedule:team-sync')
ui.element('schedule-name')
ui.element('schedule-prompt-text')
assert not any(i.get('AXLabel') == text('save') for i in ui.state()), 'Teammate schedules cannot be saved'
assert not any(i.get('AXUniqueId') == 'schedule-delete' for i in ui.state())
ui.capture('schedule-read-only')
prompt = row_text('schedule-prompt-text')
back()

# A new editor instance must render its cached detail while both refreshes are
# blocked, then keep that content after a definite refresh failure.
fixture('hold', 'detail')
fixture('hold', 'options')
open_schedule('schedule:team-sync')
fixture_state('detail', 'pending')
fixture_state('options', 'pending')
assert row_text('schedule-prompt-text') == prompt
ui.capture('schedule-cached-detail-pending')
fixture('fail', 'detail')
fixture('fail', 'options')
ui.element('schedule-retry')
assert row_text('schedule-prompt-text') == prompt
ui.capture('schedule-cached-detail-failed')
back()

# New schedule: Save stays disabled until name and prompt are set.
ui.axe('tap', '--id', 'home-new-session', '--post-delay', '.8')
ui.element('schedule-frequency')
save = labeled(text('save'))
assert not save.get('enabled', True), save
ui.axe('tap', '--id', 'schedule-name', '--post-delay', '.4')
ui.type_into('schedule-name', 'Morning triage')
created_name = ui.element('schedule-name')['AXValue']
ui.axe('tap', '--id', 'schedule-prompt', '--post-delay', '.4')
ui.axe('type', 'Triage new issues.')
ui.wait(lambda items: any(i.get('AXLabel') == text('save') and i.get('enabled') for i in items), 'Save never enabled')
ui.capture('schedule-new')
ui.axe('tap', '--label', text('save'), '--post-delay', '1')
ui.element('home-schedules-list')
labeled(created_name)
ui.capture('schedule-created')

# Delete always confirms.
open_schedule('schedule:launch-once')
list_element('schedule-delete', editor=True)
ui.axe('tap', '--id', 'schedule-delete', '--post-delay', '.6')
labeled(text('deleteTitle').replace('%@', 'Launch announcement'))
ui.capture('schedule-delete-confirm')
ui.axe('tap', '--label', text('delete'), '--post-delay', '1')
ui.element('home-schedules-list')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'schedule:launch-once' for i in items), 'Deleted schedule stayed listed')
print('PASS: Schedules tab lists sections with worded states, optimistic pause/resume rollback before reconciliation, account/workspace-isolated SQLite list on first open through pending/failed refresh and live replacement, cached detail through pending/failed refresh, swipe pause, read-only and unsupported rules, create and confirmed delete. Offline fixture; visual review required.')
