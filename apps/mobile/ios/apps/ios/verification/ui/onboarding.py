"""Native sign-in follows web /login, remains cancellable, shows errors, and closes only after account success."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
providers = ('auth.native.github', 'auth.native.google', 'auth-apple', 'auth.native.discord')
frames = [ui.element(identifier)['frame'] for identifier in providers + ('auth-email-entry',)]
for identifier, frame in zip(providers + ('auth-email-entry',), frames):
    assert frame['height'] >= 44, (identifier, frame)
# Web order: one equal-width group of providers, then the email entry below it.
assert all(a['y'] < b['y'] for a, b in zip(frames, frames[1:])), frames
assert len({round(frame['width']) for frame in frames}) == 1, frames
assert any(item.get('AXLabel') == catalog.text('auth.login.title') for item in ui.state()), 'Missing web sign-in title'
assert not any(item.get('AXUniqueId') == 'onboarding-code' for item in ui.state())
ui.capture('native-login')
# The email view slides in with the form; Back returns to the providers.
ui.axe('tap', '--id', 'auth-email-entry')
for identifier in ('auth.native.email', 'auth.native.password', 'auth-email-submit', 'auth-registration-toggle'):
    control = ui.element(identifier)
    assert control['frame']['height'] >= 44, (identifier, control['frame'])
ui.capture('email')
ui.axe('tap', '--id', 'auth-registration-toggle')
ui.element('auth.native.name')
ui.capture('create-account')
ui.axe('tap', '--id', 'auth-email-back')
ui.element('auth.native.google')
# Preview uses the production page with a deterministic service, no provider/network.
ui.axe('tap', '--id', 'auth.native.google')
ui.element('auth-cancel')
ui.capture('waiting')
ui.axe('tap', '--id', 'auth-cancel')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('auth.error.cancelledSignIn') for item in items), 'Missing cancellation error')
ui.capture('error')
ui.axe('tap', '--id', 'auth.native.google')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'onboarding-sheet' for item in items), 'Login did not close after account success')
ui.capture('closed')
print('Native sign-in matches the web layout, switches to email and supports cancellation, error recovery and account-owned completion.')
