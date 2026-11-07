"""Shared checks for the settings list loading, notice and unavailable states."""
import time

import catalog


def spoken(item):
    return ' '.join(str(item.get(key) or '') for key in ('AXLabel', 'AXValue'))


def tap(ui, identifier, delay='.5'):
    ui.element(identifier)
    ui.axe('tap', '--id', identifier, '--post-delay', delay)


def settled_y(ui, anchor):
    previous = None
    for _ in range(10):
        top = ui.element(anchor)['frame']['y']
        if top == previous:
            return top
        previous = top
        time.sleep(.3)
    return previous


# A swipe that lands while the list is still decelerating stops it instead of pulling to refresh,
# and a simulated drag can fall short of the refresh threshold, so pulls retry until `refreshed`.
def pull(ui, anchor, refreshed=None):
    for _ in range(3):
        top = settled_y(ui, anchor)
        bottom = ui.state()[0]['frame']['height'] - 30
        ui.axe('swipe', '--start-x', '200', '--start-y', str(top + 10),
               '--end-x', '200', '--end-y', str(bottom), '--duration', '1.2', '--post-delay', '1')
        if refreshed is None:
            return
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if refreshed(ui.state()):
                return
            time.sleep(.3)
    raise AssertionError(f'Pull to refresh from {anchor} never refreshed')


def has_notice(items):
    return any(item.get('AXUniqueId') == 'list-notice-text' for item in items)


def notice(ui, key=None, **values):
    item = ui.element('list-notice-text')
    if key:
        expected = catalog.text(key, **values)
        assert expected in spoken(item), f'Notice said {spoken(item)!r}, expected {expected!r}'
    return item


def no_notice(ui):
    assert not any(item.get('AXUniqueId') == 'list-notice-text' for item in ui.state()), 'Stale notice stayed visible'


def unavailable(ui, title_key):
    title = catalog.text(title_key)
    ui.wait(lambda items: any(title in spoken(item) for item in items), 'Unavailable page missing')
    assert not any(item.get('AXUniqueId') == 'retry' for item in ui.state()), 'A Retry row is still rendered'


def try_again(ui):
    ui.axe('tap', '--label', catalog.text('settings.state.tryAgain'), '--post-delay', '.5')


def no_header_refresh(ui):
    label = catalog.text('settings.remote.refresh')
    assert not any(
        item.get('AXLabel') == label and item.get('type') == 'Button' and item.get('AXUniqueId') != 'list-notice-action'
        for item in ui.state()
    ), 'Header refresh button is still shown'
