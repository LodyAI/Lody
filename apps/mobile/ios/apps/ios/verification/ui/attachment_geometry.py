"""Assert the media viewport independently of the composer and keyboard frames."""
import time

def check_media_geometry(ui, identifier):
    screen = next(item['frame'] for item in ui.state() if item.get('type') == 'Application')
    def matches(items):
        item = next((item for item in items if item.get('AXUniqueId') == identifier), None)
        if not item:
            return False
        frame = item['frame']
        return (abs(frame['height'] - screen['height'] * .60) < 2
                and abs(frame['y'] + frame['height'] - screen['y'] - screen['height'] + 12) < 2
                and abs(frame['width'] - screen['width'] + 24) < 2)
    ui.wait(matches, 'Media panel must occupy 60% of the window with 12pt edge insets')
    time.sleep(.8)  # AX publishes destination frames before the spring has settled.
