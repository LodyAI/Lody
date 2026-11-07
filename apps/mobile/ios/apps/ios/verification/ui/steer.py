"""Repeated steering keeps user bubbles outside one completed AI process."""
import sys
from driver import UI
ui = UI(*sys.argv[1:])
for index in range(1, 4):
    ui.axe('tap', '--tap-style', 'physical', '--id', 'steer-next')
    ui.wait(lambda items: any(i.get('AXUniqueId') == f'steer-user-{index}:user' for i in items), 'Guidance did not appear')
    assert not any(i.get('AXUniqueId') == 'steer-user-0:execution' for i in ui.state())
ui.capture('running-three-guides')
ui.axe('tap', '--tap-style', 'physical', '--id', 'steer-finish')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'steer-user-0:execution' for i in items), 'Combined process missing')
items = ui.state()
ids = [i.get('AXUniqueId') for i in items]
for index in range(4):
    assert ids.count(f'steer-user-{index}:user') == 1
assert 'steer-ai-3:answer' in ids and 'steer-ai-3:answer-next' in ids
assert not any(f'steer-ai-{index}:partial' in ids for index in range(4))
ui.capture('finished-guidance-outside')
ui.axe('tap', '--tap-style', 'physical', '--id', 'steer-user-0:execution')
ui.wait(lambda items: any(i.get('AXLabel') == 'Close Activity' for i in items), 'Process detail did not open')
if not any(i.get('AXUniqueId') == 'steer-ai-0:partial' for i in ui.state()):
    grabber = next(i['frame'] for i in ui.state() if i.get('AXLabel') == 'Sheet Grabber')
    ui.axe('swipe', '--start-x', str(grabber['x'] + grabber['width'] / 2),
           '--start-y', str(grabber['y'] + grabber['height'] / 2),
           '--end-x', '200', '--end-y', '90', '--duration', '.6')
    ui.axe('swipe', '--start-x', '200', '--start-y', '250',
           '--end-x', '200', '--end-y', '650', '--duration', '.6')
ui.wait(lambda items: any(i.get('AXUniqueId') == 'steer-ai-0:partial' for i in items), 'Earlier AI process missing from detail')
ui.capture('expanded-ai-process')
print('PASS: three guidance messages remain outside one AI process; earlier stages are accessible and final result stays separate')
