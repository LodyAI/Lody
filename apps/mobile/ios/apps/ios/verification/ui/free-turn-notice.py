"""Free turn reminder appears at 25, updates with the remaining count, and hides for Plus."""
import sys
from driver import UI
import catalog

ui = UI(*sys.argv[1:])


def notice():
    return next((item for item in ui.state()
                 if item.get('AXUniqueId') == 'session-free-turn-notice' and item.get('AXLabel')), None)


assert notice() is None, 'The reminder appeared before 25 turns'
ui.axe('tap', '--id', 'free-turn-25')
ui.wait(lambda _: notice() is not None, 'The 25-turn reminder did not appear')
assert notice()['AXLabel'] == catalog.plural('chat.composer.freeTurnsRemaining', 5, remaining=5)
ui.capture('five-turns-left')
ui.axe('tap', '--id', 'free-turn-29')
ui.wait(lambda _: notice() and notice()['AXLabel'] == catalog.plural('chat.composer.freeTurnsRemaining', 1, remaining=1), 'The remaining count did not update')
ui.capture('one-turn-left')
ui.axe('tap', '--id', 'free-turn-30')
ui.wait(lambda items: catalog.text('chat.composer.freeTurnLimitTitle') in [item.get('AXLabel') for item in items], 'The limit alert did not appear')
ui.capture('limit-reached')
ui.axe('tap', '--label', catalog.text('common.ok'), '--post-delay', '.4')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'session-input' for item in items), 'The composer stayed open after the limit')
ui.axe('tap', '--id', 'free-turn-plus')
ui.wait(lambda items: not any(item.get('AXUniqueId') == 'session-free-turn-notice' and item.get('AXLabel') for item in items) and any(item.get('AXUniqueId') == 'session-input' for item in items), 'Paid workspace still hides the composer')
ui.capture('plus-no-reminder')
