"""SwiftUI sharing form: explicit publication and automatic copy; failed upload, retry, update, reset and revoke offline."""
import subprocess
import sys
from driver import UI

ui = UI(*sys.argv[1:])

def tap(identifier):
    ui.axe('tap', '--id', identifier, '--post-delay', '.4')

def wait(identifier):
    ui.wait(lambda items: any(i.get('AXUniqueId') == identifier for i in items), f'Missing {identifier}', timeout=20)

def pasted():
    return subprocess.check_output(['xcrun', 'simctl', 'pbpaste', ui.udid], text=True).strip()

def confirm(label):
    sheet = ui.wait(lambda items: next((i for i in items if i.get('role') == 'AXSheet' and i.get('AXLabel') == label), None), 'Confirmation missing')
    def walk(node):
        yield node
        for child in node.get('children', []):
            yield from walk(child)
    button = next(i for i in walk(sheet) if i.get('type') == 'Button' and i.get('AXLabel') == label)
    frame = button['frame']
    ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.6')

tap('open-session-share')
wait('share-publish')
assert ui.element('share-publish')['AXLabel'] == 'Create and copy link'
assert ui.element('share-publish')['frame']['height'] >= 44
assert ui.element('share-include-children').get('AXValue') == '0'
assert not any(i.get('AXUniqueId') == 'share-copy' for i in ui.state())
ui.capture('scope-before-publication')
scope = ui.element('share-include-children')
switch = next(child for child in scope['children'] if child.get('subrole') == 'AXSwitch')
ui.tap_switch(switch)
ui.wait(lambda items: any(i.get('AXUniqueId') == 'share-include-children' and i.get('AXValue') == '1' for i in items), 'Include children switch did not enable')
tap('share-publish')
wait('share-progress')
assert any(i.get('AXLabel') == 'Done' and not i.get('enabled', True) for i in ui.state()), 'Publishing must disable Done'
ui.capture('publication-progress')
wait('share-reload')
assert not any(i.get('AXUniqueId') == 'share-copy' for i in ui.state())
assert ui.element('share-include-children').get('AXValue') == '1', 'Failure lost the selected scope'
assert not ui.element('share-include-children')['enabled'], 'Pending upload scope must stay frozen'
ui.capture('upload-failure-no-link')
tap('share-reload')
wait('share-copy')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'share-progress' for i in items), 'Publication did not finish')
assert 'fixture-v1' in pasted()
ui.capture('published-link')
tap('share-publish')
wait('share-progress')
wait('share-copy')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'share-progress' for i in items), 'Publication did not finish')
assert 'fixture-v1' in pasted(), 'Updating changed the link'
tap('share-system')
wait('ActivityListView')
ui.capture('system-share')
frame = ui.element('ActivityListView')['frame']
ui.axe('tap', '-x', '20', '-y', str(max(50, frame['y'] - 40)), '--post-delay', '.6')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'ActivityListView' for i in items), 'System share did not dismiss')
# Bring the bottom management group above the home indicator with a real scroll.
for _ in range(3):
    revoke = ui.element('share-revoke')['frame']
    if revoke['y'] + revoke['height'] < 840:
        break
    ui.axe('swipe', '--start-x', '65', '--start-y', '650', '--end-x', '65', '--end-y', '300', '--duration', '.5', '--post-delay', '.7')
revoke = ui.element('share-revoke')['frame']
assert revoke['y'] + revoke['height'] < 840, 'Management actions must scroll clear of the safe area'
ui.capture('management-scrolled')
tap('share-reset')
ui.axe('tap', '--label', 'Cancel')
tap('share-copy')
assert 'fixture-v1' in pasted()
tap('share-reset')
confirm('Reset link')
tap('share-copy')
assert 'fixture-v2' in pasted()
ui.capture('reset-link')
tap('share-revoke')
confirm('Revoke share')
ui.wait(lambda items: not any(i.get('AXUniqueId') == 'share-copy' for i in items), 'Revoked link is still offered')
ui.capture('revoked')
ui.axe('tap', '--label', 'Done', '--post-delay', '.6')
wait('open-session-share')
print('PASS: scope, publishing progress, failure without a link, retry, stable update, system sharing, reset cancellation, rotation and revocation')
