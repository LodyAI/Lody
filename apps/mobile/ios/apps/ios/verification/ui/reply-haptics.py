"""Offline adjustable reply demo. Pulse counts prove native scheduling, not physical feel."""
import re
import sys
import time
from driver import UI

ui = UI(*sys.argv[1:])


def tap(identifier):
    ui.axe('tap', '--id', identifier, '--tap-style', 'physical', '--post-delay', '.2')


def wait_status(expected):
    ui.wait(lambda items: any(expected in (item.get('AXLabel') or '') for item in items),
            f'Missing status: {expected}', timeout=12)


def choose(identifier, value):
    tap(identifier)
    ui.axe('tap', '--label', value, '--tap-style', 'physical', '--post-delay', '.3')


ui.capture('parameters')
tap('reply-haptics-start')
ui.wait(lambda items: any(re.fullmatch(r'完成 · [1-9]\d* 次触感', item.get('AXLabel') or '') for item in items),
        'Default reply scheduled no native pulses', timeout=12)
ui.capture('streamed')
ui.axe('swipe', '--start-x', '200', '--start-y', '650', '--end-x', '200', '--end-y', '250', '--duration', '.4', '--post-delay', '.3')
choose('firstDelay', '6000')
ui.axe('swipe', '--start-x', '200', '--start-y', '250', '--end-x', '200', '--end-y', '750', '--duration', '.4', '--post-delay', '.3')
tap('reply-haptics-start')
wait_status('完成 · 0 次触感')
ui.capture('outside-window')
tap('reply-haptics-start')
tap('reply-haptics-stop')
time.sleep(1)
wait_status('已停止')
ui.capture('stopped')
print('PASS: native-scheduled, late and cancelled replies; real-device haptics remain manual')
