"""Assert the media viewport independently of the composer and keyboard frames."""
import time

def check_media_geometry(ui, identifier):
    screen = next(item['frame'] for item in ui.state() if item.get('type') == 'Application')
    inset = 12 if identifier == 'attachment-photos-grid' else 0
    def matches(items):
        item = next((item for item in items if item.get('AXUniqueId') == identifier), None)
        if not item:
            return False
        frame = item['frame']
        return (abs(frame['height'] + 2 * inset - screen['height'] * .60) < 2
                and abs(frame['y'] + frame['height'] - screen['y'] - screen['height'] + 12 + inset) < 2
                and abs(frame['width'] - screen['width'] + 24 + 2 * inset) < 2)
    ui.wait(matches, 'Media panel must occupy 60% of the window with 12pt edge insets')
    time.sleep(.8)  # AX publishes destination frames before the spring has settled.


def check_composer_attachment_targets(ui, field, preview_label):
    """Large aligned tiles reserve their centers for preview; removal is independent."""
    import catalog
    prefix = catalog.text('native.chat.attachment.preview', name='')
    remove_label = catalog.text('native.chat.attachment.remove', name=preview_label[len(prefix):])
    ui.wait_for_keyboard(field)
    items = ui.state()
    previews = [item for item in items if (item.get('AXLabel') or '').startswith(prefix)]
    preview = next(item for item in previews if item.get('AXLabel') == preview_label)['frame']
    remove = next(item for item in items if item.get('AXLabel') == remove_label)['frame']
    editor = ui.element(field)['frame']
    scale = ui.element('session-attach')['frame']['width'] / 44
    assert abs(preview['height'] - 80 * scale) <= 1, f'Attachment tile is too short: {preview}'
    assert abs(preview['width'] - 80 * scale) <= 1, f'Image tile is not square: {preview}'
    first = min(previews, key=lambda item: item['frame']['x'])['frame']
    assert abs(first['x'] - editor['x'] - 16 * scale) <= 1, f'Attachment edge does not align with text: {first} / {editor}'
    assert remove['width'] >= 30 * scale - 1 and remove['height'] >= 30 * scale - 1, 'Removal hit area shrank'
    assert remove['x'] >= preview['x'] + preview['width'] / 2, 'Remove overlaps the center preview target'
    assert remove['y'] + remove['height'] < preview['y'] + preview['height'] / 2, 'Remove covers too much of the preview'
    draft = ui.element(field).get('AXValue')
    ui.capture('aligned-attachment')
    remove = next(item for item in ui.state() if item.get('AXLabel') == remove_label)['frame']
    ui.axe('tap', '-x', str(remove['x'] + remove['width'] / 2), '-y', str(remove['y'] + remove['height'] / 2),
           '--tap-style', 'physical')
    ui.wait(lambda items: not any(item.get('AXLabel') == preview_label for item in items), 'Remove did not delete the selected attachment')
    remaining = [item for item in ui.state() if (item.get('AXLabel') or '').startswith(prefix)]
    assert len(remaining) == len(previews) - 1, 'Remove changed another attachment'
    assert ui.element(field).get('AXValue') == draft, 'Remove changed the text draft'
    ui.capture('attachment-removed')
