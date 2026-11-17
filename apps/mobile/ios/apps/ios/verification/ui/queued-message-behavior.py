"""Preferences stay local, survive restart, and push native notification settings."""
import plistlib
import subprocess
import sys
from pathlib import Path
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=catalog.text('settings.preferences.title')), '--post-delay', '.4')
ui.open_case('settings-baseline-live')
entry = ui.element('preferences')
assert catalog.text('settings.preferences.subtitle') in entry['AXLabel']
ui.capture('settings-language-entry')
ui.axe('tap', '--id', 'preferences', '--post-delay', '.4')

def choose(value):
    row = ui.element('queued-message-behavior')
    assert row['frame']['height'] >= 44
    ui.axe('tap', '--id', 'queued-message-behavior', '--post-delay', '.5')
    ui.capture(f'{value}-menu')
    ui.axe('tap', '--label', catalog.text(f'settings.queuedMessageBehavior.{value}'), '--post-delay', '.7')
    ui.wait(lambda _: ui.element('queued-message-behavior').get('AXValue') == catalog.text(f'settings.queuedMessageBehavior.{value}'), 'Selected value did not update')
    ui.element('notifications')
    ui.element('queued-message-behavior')
    ui.capture(f'{value}-selected')


ui.capture('preferences')
assert ui.element('language')['frame']['height'] >= 44
assert ui.element('language')['AXValue'] == 'English'
assert ui.element('notifications')['frame']['height'] >= 44
choose('queue')
choose('guide')
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
prefs = container / 'Library/Preferences/ai.lody.mobile.plist'


def saved():
    return plistlib.loads(prefs.read_bytes()).get('queuedMessageBehavior')


ui.wait(lambda _: saved() == 'guide', 'Steer preference was not persisted')
ui.axe('tap', '--id', 'notifications', '--post-delay', '.5')
permission = ui.element('notification-permission')
assert catalog.text('notifications.hint.signedOut') in permission['AXLabel']
ui.capture('notifications-signed-out')
ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '65',
       '--end-y', '450', '--duration', '1', '--post-delay', '.6')
ui.element('notification-permission')
ui.capture('notification-pop-cancelled')
ui.axe('drag', '--start-x', '2', '--start-y', '450', '--end-x', '365',
       '--end-y', '450', '--duration', '.5', '--post-delay', '.6')
assert ui.element('queued-message-behavior')['AXValue'] == catalog.text('settings.queuedMessageBehavior.guide')
ui.capture('notification-returned')

subprocess.run(['xcrun', 'simctl', 'terminate', ui.udid, 'ai.lody.mobile'], check=True, timeout=30)
ui.invalidate_axe()
launch = ['xcrun', 'simctl', 'launch', ui.udid, 'ai.lody.mobile', '--ui-verify', '-AppleLanguages', '(en)', '-AppleLocale', 'en_US']
subprocess.run(launch, check=True, timeout=30)
ui.element('ui-verify-ready', timeout=90)
ui.open_case('preferences-preview')
assert ui.element('queued-message-behavior')['AXValue'] == catalog.text('settings.queuedMessageBehavior.guide')
assert saved() == 'guide'
ui.capture('steer-restored-after-restart')
# The public URL may preserve Settings' current page on Simulator.
ui.axe('tap', '--id', 'language', '--post-delay', '.6')
ui.invalidate_axe()
ui.wait(lambda items: any(i.get('AXLabel') == 'Settings' and i.get('type') == 'Application' for i in items),
        'Language row did not open iOS Settings')
ui.capture('language-opened-settings')
if not any(i.get('AXUniqueId') == 'PREFERRED_LANGUAGE' for i in ui.state()):
    # Follow the product's displayed path if the OS left Settings elsewhere.
    for _ in range(5):
        if not any(i.get('AXUniqueId') == 'BackButton' for i in ui.state()):
            break
        ui.axe('tap', '--id', 'BackButton', '--post-delay', '.3')
    for _ in range(4):
        if any(i.get('AXUniqueId') == 'com.apple.settings.apps' for i in ui.state()):
            break
        ui.axe('swipe', '--start-x', '200', '--start-y', '740', '--end-x', '200', '--end-y', '380',
               '--duration', '.4', '--post-delay', '.4')
    # A freshly booted pool Simulator can show an empty Apps list while it indexes; reopening reloads it.
    for attempt in range(3):
        ui.axe('tap', '--id', 'com.apple.settings.apps', '--post-delay', '.4')
        try:
            ui.element('ai.lody.mobile', timeout=20)
            break
        except AssertionError:
            ui.capture(f'language-apps-empty-{attempt}')
            if attempt == 2:
                raise
            ui.axe('tap', '--id', 'BackButton', '--post-delay', '.6')
    ui.axe('tap', '--id', 'ai.lody.mobile', '--post-delay', '.4')
language = ui.element('PREFERRED_LANGUAGE')
assert 'English' in language['AXLabel']
ui.capture('language-system-settings')
ui.axe('tap', '--id', 'PREFERRED_LANGUAGE', '--post-delay', '.4')
ui.element('English')
ui.element('简体中文')
ui.capture('language-system-choices')
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.4')
assert 'English' in ui.element('PREFERRED_LANGUAGE')['AXLabel']
ui.capture('language-selection-cancelled')
subprocess.run(['xcrun', 'simctl', 'launch', ui.udid, 'ai.lody.mobile'], check=True, timeout=30)
ui.invalidate_axe()
assert ui.element('language')['AXValue'] == 'English'
assert ui.element('queued-message-behavior')['AXValue'] == catalog.text('settings.queuedMessageBehavior.guide')
assert saved() == 'guide'
ui.capture('language-return-preserves-preferences')
choose('queue')
ui.wait(lambda _: saved() == 'queue', 'Queue preference was not persisted')
ui.axe('tap', '--label', catalog.text('accessibility.closeSheet', title=catalog.text('settings.preferences.title')), '--post-delay', '.5')
print('PASS: language opens iOS Settings; system language choices, cancelled selection, return, cold launch and native navigation preserve local preferences.')
