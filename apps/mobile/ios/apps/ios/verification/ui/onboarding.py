"""The signed-out welcome sheet cannot be dismissed and closes itself once an account arrives."""
import subprocess
import sys
from driver import UI, axe_session_dead
import catalog

ui = UI(sys.argv[1], sys.argv[2])


def tap(identifier, delay):
    """A press replaces this control. AXe can report a miss after the press already landed."""
    try:
        ui.axe('tap', '--id', identifier, '--post-delay', delay)
    except (subprocess.CalledProcessError, RuntimeError) as error:
        if axe_session_dead(error):
            raise


def has_label(text):
    return lambda items: any(item.get('AXLabel') == text for item in items)


def intro_settled(step, plays, keys):
    """UIKit leaves views below 0.01 alpha out of accessibility, so every block being listed means none stayed hidden."""
    probe = ui.wait(lambda items: next((item for item in items if item.get('AXUniqueId') == 'onboarding-intro' and item.get('AXLabel') == f'plays {plays}' and item.get('AXValue') in ('settled', 'reduced', 'unsettled')), None), f'Intro play {plays} never finished ({step})')
    assert probe.get('AXValue') in ('settled', 'reduced'), f'Intro ended with blocks off their final state ({step}): {probe.get("AXValue")}'
    labels = [item.get('AXLabel') or '' for item in ui.state()]
    for key in keys:
        assert any(catalog.text(key) in label for label in labels), f'{key} is not visible after the intro ({step})'


connect = ui.element('onboarding-connect')
screen = ui.state()[0]['frame']
sheet = ui.element('onboarding-sheet')['frame']
if screen['width'] >= 700:
    assert sheet['width'] < screen['width'] - 80, ('iPad welcome must have side margins', sheet, screen)
    assert sheet['height'] < screen['height'] - 80, ('iPad welcome must have top and bottom margins', sheet, screen)
    assert abs(sheet['x'] + sheet['width'] / 2 - screen['x'] - screen['width'] / 2) < 4, ('Welcome is not horizontally centered', sheet, screen)
    # UIKit's form sheet uses the available area around system safe areas.
    assert abs(sheet['y'] + sheet['height'] / 2 - screen['y'] - screen['height'] / 2) < 16, ('Welcome is not vertically centered', sheet, screen)
assert connect['frame']['height'] >= 44
assert not any(item.get('AXUniqueId') == 'xmark' or item.get('AXLabel') == catalog.system('close') for item in ui.state()), 'Welcome sheet must not offer a close button'
for key in ('onboarding.sessions.title', 'onboarding.reply.title', 'onboarding.privacy.title'):
    ui.wait(lambda items, key=key: any(catalog.text(key) in (item.get('AXLabel') or '') for item in items), f'Missing feature {key}')
features = ('onboarding.sessions.title', 'onboarding.reply.title', 'onboarding.privacy.title')
intro_settled('open', 1, (*features, 'onboarding.title', 'login.footnote'))
ui.capture('idle')

ui.screenshot('connect-label')
connect_frame = ui.element('onboarding-connect')['frame']
probe_width = round(screen['width'])
row = round(connect_frame['y'] + connect_frame['height'] / 2)
pixels = subprocess.check_output([
    'ffmpeg', '-v', 'error', '-i', str(ui.output / 'connect-label.png'),
    '-vf', f'scale={probe_width}:-1,crop={probe_width}:1:0:{row}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
], timeout=20)
span = pixels[round(connect_frame['x'] + 16):round(connect_frame['x'] + connect_frame['width'] - 16)]
assert max(span) - min(span) > 110, ('The Connect label must contrast with its fill', min(span), max(span))

# Stop above the connect control. A drag that runs through it can press the button
# when the gesture is cut short by the next accessibility command.
start_y = sheet['y'] + 20
end_y = connect['frame']['y'] - 36
if end_y < start_y + 80:
    end_y = start_y + 80
x = sheet['x'] + sheet['width'] / 2
ui.axe('drag', '--start-x', str(x), '--start-y', str(start_y),
       '--end-x', str(x), '--end-y', str(end_y), '--duration', '.5', '--post-delay', '1')
ui.element('onboarding-connect')
ui.capture('after-swipe')

tap('onboarding-connect', '.8')
assert ui.element('onboarding-code').get('AXValue') == 'WXYZ-1234' or 'WXYZ-1234' in (ui.element('onboarding-code').get('AXLabel') or '')
ui.wait(has_label(catalog.text('login.waiting')), 'Missing waiting copy')
ui.capture('waiting')

tap('auth-cancel', '.8')
ui.wait(has_label(catalog.text('auth.error.cancelledSignIn')), 'Missing cancelled error')
assert ui.element('onboarding-connect').get('AXLabel') == catalog.text('login.retry')
intro_settled('error', 2, features)
ui.capture('error')

tap('onboarding-connect', '1.2')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'onboarding-sheet' for item in items), 'Sheet did not close after sign-in')
ui.element('onboarding-preview')
ui.capture('closed')

# Device Flow publishes the account before dismissing its SFSafariViewController.
# Dismissing the content controller only closes Safari and strands the finished sheet.
ui.open_case('onboarding-preview')
ui.element('onboarding-connect')
tap('onboarding-connect', '.8')
ui.element('onboarding-code')
ui.axe('tap', '--label', catalog.text('login.reopen'), '--post-delay', '1.2')
ui.wait(lambda items: any(item.get('AXUniqueId') == 'onboarding-preview' for item in items)
        and not any(item.get('AXUniqueId') == 'onboarding-sheet' for item in items),
        'Welcome sheet stayed after sign-in with the authorization browser open')
ui.capture('browser-closed')
print('Welcome sheet resists drag, supports cancel and retry, and closes on sign-in with or without the authorization browser open.')
