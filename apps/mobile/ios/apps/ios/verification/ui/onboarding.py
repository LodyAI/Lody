"""Native sign-in remains cancellable, shows errors, and closes only after account success."""
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
for identifier in ('auth.native.email', 'auth.native.password', 'auth-email-submit', 'auth-apple', 'auth.native.google', 'auth.native.github', 'auth.native.discord'):
    control = ui.element(identifier)
    assert control['frame']['height'] >= 44, (identifier, control['frame'])
assert not any(item.get('AXUniqueId') == 'onboarding-code' for item in ui.state())
ui.capture('native-login')
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
print('Native provider selection supports cancellation, error recovery and account-owned completion.')
