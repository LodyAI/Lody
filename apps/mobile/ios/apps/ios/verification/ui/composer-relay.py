"""Same production composer survives Sheet -> chat before its normal send."""
import json
from pathlib import Path
import subprocess
import sys
from driver import UI

ui = UI(*sys.argv[1:])
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
for delayed in [False, True]:
    if delayed:
        ui.axe('tap', '--label', 'Try again', '--post-delay', '.6')
        ui.axe('tap', '--id', 'composer-relay-delay')
    ui.axe('tap', '--id', 'composer-relay-open', '--post-delay', '1')
    draft = ui.element('session-input')['AXValue']
    assert ui.element('inputView')['frame']['height'] > 200
    ui.capture('delayed-source' if delayed else 'source')
    ui.axe('tap', '--id', 'session-send', '--tap-style', 'physical', '--post-delay', '.2')
    ui.wait(lambda items: any(i.get('AXLabel') == draft and (i.get('AXUniqueId') or '').endswith(':user') for i in items), 'Transferred composer did not send its original draft')
    assert ui.element('inputView')['frame']['height'] > 200
    report = json.loads((container / 'tmp/lody-composer-relay.json').read_text())
    assert report['sameComposer'] and report['focusedBefore'] and report['focusedAfter'], report
    assert report['appearanceBefore'] == report['appearanceAfter'], report
    assert max(abs(a - b) for a, b in zip(report['source'], report['adopted'])) < 1.5, report
    ui.capture('delayed-landed' if delayed else 'landed')
    print(json.dumps(report), flush=True)
print('PASS: same composer, aligned geometry, retained focus/keyboard, normal send, delayed preparation')
