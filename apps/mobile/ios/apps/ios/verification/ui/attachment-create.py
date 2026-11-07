"""Attachment overlay in the production native CreateSessionController host."""
import sys
from driver import UI
from attachment_geometry import check_media_geometry
import catalog

ui = UI(*sys.argv[1:])

def tap(identifier):
    f = ui.element(identifier)['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.6')

field = 'create-session-input'
tap(field)
tip = next((i for i in ui.state() if i.get('type') == 'Button' and i.get('AXLabel') in ['Continue', '继续'] and i['frame']['y'] > 600), None)
if tip:
    f = tip['frame']
    ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.6')
ui.type_into(field, 'native form draft')
draft = ui.element(field).get('AXValue')
tap('session-attach')
ui.element('attachment-menu-takePhoto')
ui.capture('native-form-menu')
tap('attachment-menu-recentPhotos')
tap('attachment-photos-access')
permission = ui.wait(lambda items: next((i for i in items if i.get('type') == 'Button' and i.get('AXLabel') in ['Allow Full Access', 'Allow Access to All Photos', '允许完全访问', '允许访问所有照片']), None), 'Photos permission missing')
f = permission['frame']
ui.axe('tap', '-x', str(f['x'] + f['width'] / 2), '-y', str(f['y'] + f['height'] / 2), '--post-delay', '.8')
ui.element('attachment-photo-0')
check_media_geometry(ui, 'attachment-photos-grid')
keyboard = ui.wait(lambda items: next((i for i in items if (i.get('AXUniqueId') or '').startswith('UIKeyboardLayoutStar')), None), 'Keyboard missing')['frame']
assert ui.element('attachment-photos-back')['frame']['y'] > keyboard['y'], 'Native form overlay returned behind the keyboard'
ui.capture('native-form-photos')
tap('attachment-photo-0')
tap('attachment-photos-confirm')
preview = catalog.text('native.chat.attachment.preview', name='')
ui.wait(lambda items: any((i.get('AXLabel') or '').startswith(preview) for i in items), 'Photo missing from native form draft')
assert ui.element(field).get('AXValue') == draft
ui.capture('native-form-attachment')
print('PASS: native CreateSessionController preserves draft and attachment across permission and overlay handoff')
