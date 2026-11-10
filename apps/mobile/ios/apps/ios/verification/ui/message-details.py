"""Native collection-view turn details, offline in both appearances."""
import sys
from driver import UI
ui = UI(*sys.argv[1:])

def open_details():
    button = ui.element('paper-reply:meta:details')
    assert button['frame']['height'] >= 44 and button['frame']['width'] >= 44
    ui.axe('tap', '--id', 'paper-reply:meta:details', '--post-delay', '.5')
    ui.wait(lambda items: any(i.get('AXLabel') == 'Turn details' for i in items), 'Details sheet did not open')

def close():
    ui.axe('tap', '--label', 'Done', '--post-delay', '.5')
    ui.element('paper-reply:meta:actions')

def fixture(name):
    ui.axe('tap', '--label', 'Paper fixtures')
    ui.axe('tap', '--label', name, '--post-delay', '.5')

open_details()
for key, value in [('model', 'GPT-6 Astra'), ('reasoning', 'High'), ('fast', 'Off'), ('input', '1,234'), ('output', '8,640')]:
    row = ui.element(key)
    assert value in str(row), row
ui.capture('configuration-and-tokens')
ui.axe('drag', '--start-x', '220', '--start-y', '740', '--end-x', '220', '--end-y', '370', '--duration', '.5', '--post-delay', '.5')
for key, value in [('reasoningTokens', '2,000'), ('cacheRead', '120,000'), ('cacheWrite', '4,096')]:
    assert value in str(ui.element(key))
ui.capture('token-breakdown')
close()
fixture('no-meta')
open_details()
ui.wait(lambda items: any(i.get('AXLabel') == 'No details recorded for this turn.' for i in items), 'Missing empty state')
assert not any(i.get('AXUniqueId') == 'input' for i in ui.state())
ui.capture('missing-metadata')
close()
fixture('late-usage')
open_details()
ui.wait(lambda items: any(i.get('AXUniqueId') == 'output' and '8,640' in str(i) for i in items), 'Late usage did not refresh the open sheet')
ui.capture('late-usage')
close()
ui.axe('tap', '--id', 'paper-reply:meta:actions')
ui.wait(lambda items: any(i.get('AXLabel') == 'Copy entire message' for i in items), 'Message actions did not open')
ui.capture('message-actions-retained')
print('PASS: UICollectionView details, exact usage, missing metadata, late updates and original menu')
