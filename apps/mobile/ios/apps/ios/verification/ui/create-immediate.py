"""Run on --ui-verify --ui-verify-home --ui-verify-mentions, never a live account.
The pushed creation form must reveal its local conversation without a server ACK.
"""
import sys
import signal
import subprocess
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
ui.element('ui-verify-ready')
ui.axe('tap', '--label', catalog.text('create.title'), '--post-delay', '.5')
ui.type_into('create-session-input', 'Immediate navigation test')
ui.capture('before')
# Keep the transition evidence: a final screenshot alone misses an intermediate Home flash.
with (ui.output / 'transition.log').open('w') as log:
    recording = subprocess.Popen(['xcrun', 'simctl', 'io', ui.udid, 'recordVideo', '--codec=h264', '--force', str(ui.output / 'transition.mp4')], stdout=log, stderr=log)
    try:
        ui.axe('tap', '--id', 'session-send', '--tap-style', 'physical', '--post-delay', '.7')
        ui.element('chat-navigation-title')
        ui.element('session-input')
        items = ui.state()
        assert not any(i.get('AXUniqueId') == 'create-session-input' for i in items), 'Creation is still covering the destination'
        assert any('Immediate navigation test' in (i.get('AXLabel') or '') for i in items), 'Local first turn is missing'
        ui.capture('after')
    finally:
        recording.send_signal(signal.SIGINT)
        recording.wait(timeout=10)
ui.axe('tap', '--id', 'BackButton', '--post-delay', '.6')
items = ui.state()
assert not any(i.get('AXUniqueId') == 'create-session-input' for i in items), 'Back reopened the submitted form'
assert any(i.get('AXLabel') == catalog.text('create.title') for i in items), 'Back did not return to Home'
ui.capture('returned')
