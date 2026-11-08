"""Offline --ui-verify-home Schedules tab: production list and editor over the scripted ScheduleFixture."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def text(key, **variables):
    return catalog.text('schedules.' + key, **variables)


def labeled(label):
    return ui.wait(lambda items: next((i for i in items if i.get('AXLabel') == label), None), f'Missing {label}')


def row_text(identifier):
    row = ui.element(identifier)
    return ' '.join(str(row.get(key) or '') for key in ('AXLabel', 'AXValue'))


def wait_row(identifier, fragment):
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier and fragment in ' '.join(str(i.get(k) or '') for k in ('AXLabel', 'AXValue'))
                              for i in items), f'{identifier} never showed {fragment}')


def back():
    button = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') == 'Back'), None), 'Missing native Back')
    f = button['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.8')
    ui.element('home-schedules-list')


ui.element('home-chat-list')
ui.axe('tap', '--id', 'home-tab-schedules', '--post-delay', '.8')
ui.element('home-schedules-list')
ui.element('workspace-menu')
ui.element('schedules-section:tasks')
ui.element('schedules-section:messages')
# Status in words; only the blocked task is tinted and names its reason.
assert text('state.blocked') in row_text('schedule:nightly-build')
assert text('paused') in row_text('schedule:weekly-digest')
assert text('status.manual') in row_text('schedule:release-check')
ui.capture('schedules-list')

# The tab bar's create action reads "+ New schedule" here.
create = ui.element('home-new-session')
assert create.get('AXLabel') == text('new'), create

# Swipe a timed task: Pause (and Delete) only, never a full-swipe commit.
row = ui.element('schedule:daily-review')['frame']
y = row['y'] + row['height'] / 2
ui.axe('drag', '--start-x', str(row['x'] + row['width'] - 12), '--start-y', str(y),
       '--end-x', str(row['x'] + row['width'] / 2), '--end-y', str(y), '--duration', '.6', '--post-delay', '.5')
labeled(text('pause'))
ui.capture('schedules-swipe')
ui.axe('tap', '--label', text('pause'), '--post-delay', '.8')
wait_row('schedule:daily-review', text('paused'))

# A rule the menu cannot name stays read only with Replace.
ui.axe('tap', '--id', 'schedule:legacy-cron', '--post-delay', '.8')
ui.element('schedule-replace')
ui.element('schedule-name')
ui.capture('schedule-unsupported')
back()

# A teammate's schedule is read only: no Save, no More menu.
ui.axe('tap', '--id', 'schedule:team-sync', '--post-delay', '.8')
ui.element('schedule-name')
ui.element('schedule-prompt-text')
assert not any(i.get('AXLabel') == text('save') for i in ui.state()), 'Teammate schedules cannot be saved'
assert not any(i.get('AXUniqueId') == 'schedule-delete' for i in ui.state())
ui.capture('schedule-read-only')
back()

# New schedule: Save stays disabled until name and prompt are set.
ui.axe('tap', '--id', 'home-new-session', '--post-delay', '.8')
ui.element('schedule-frequency')
save = labeled(text('save'))
assert not save.get('enabled', True), save
ui.axe('tap', '--id', 'schedule-name', '--post-delay', '.4')
ui.type_into('schedule-name', 'Morning triage')
ui.axe('tap', '--id', 'schedule-prompt', '--post-delay', '.4')
ui.axe('type', 'Triage new issues.')
ui.wait(lambda items: any(i.get('AXLabel') == text('save') and i.get('enabled') for i in items), 'Save never enabled')
ui.capture('schedule-new')
ui.axe('tap', '--label', text('save'), '--post-delay', '1')
ui.element('home-schedules-list')
labeled('Morning triage')
ui.capture('schedule-created')

# Delete always confirms.
ui.axe('tap', '--id', 'schedule:launch-once', '--post-delay', '.8')
ui.axe('tap', '--id', 'schedule-delete', '--post-delay', '.6')
labeled(text('deleteTitle').replace('%@', 'Launch announcement'))
ui.capture('schedule-delete-confirm')
ui.axe('tap', '--label', text('delete'), '--post-delay', '1')
ui.element('home-schedules-list')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'schedule:launch-once' for i in items), 'Deleted schedule stayed listed')
print('PASS: Schedules tab lists sections with worded states, swipe pause, read-only and unsupported rules, create and confirmed delete. Offline fixture; visual review required.')
