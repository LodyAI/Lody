"""MCP files open native previews without credentials or an online machine."""
from pathlib import Path
import subprocess
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ui'))
from driver import UI
import catalog

ui = UI(*sys.argv[1:])
container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', ui.udid, 'ai.lody.mobile', 'data'], text=True).strip())
movie = container / 'Documents/ui-verify-attachment.mp4'
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                'testsrc2=size=320x180:rate=15', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(movie)], check=True)


def close():
    if any(item.get('AXLabel') == catalog.text('native.close') for item in ui.state()):
        ui.axe('tap', '--label', catalog.text('native.close'), '--post-delay', '.5')
        ui.element('mcp-files:text')
        return
    if not any(item.get('type') == 'Button' and (item.get('AXLabel') or '').lower() in ['done', 'close'] for item in ui.state()):
        frame = ui.element('QLPreviewControllerView')['frame']
        ui.axe('tap', '-x', str(frame['x'] + frame['width'] / 2), '-y', str(frame['y'] + frame['height'] / 2), '--post-delay', '.2')
    button = ui.wait(lambda items: next((item for item in items if item.get('type') == 'Button'
                    and (item.get('AXLabel') or '').lower() in ['done', 'close']), None), 'Quick Look must offer Close')
    ui.axe('tap', '--label', button['AXLabel'], '--post-delay', '.5')
    ui.element('mcp-files:text')


def loaded():
    ui.element('QLPreviewControllerView')
    ui.wait(lambda items: not any(item.get('AXLabel') == catalog.text('native.attachment.preview.loading') for item in items), 'File loading never finished')
    time.sleep(.8)
    assert not any(item.get('AXLabel') == catalog.text('native.attachment.preview.retry') for item in ui.state()), 'Preview failed to load'


ui.axe('tap', '--label', 'MCP Attachments', '--post-delay', '.5')
for file in ['text', 'pdf', 'video', 'retry', 'missing', 'pending', 'cancel']:
    assert ui.element('mcp-files:' + file)['type'] == 'Button'
ui.capture('files-inline')
for file in ['text', 'pdf', 'video']:
    ui.axe('tap', '--id', 'mcp-files:' + file, '--post-delay', '.2')
    loaded()
    ui.capture(file + '-preview')
    if file == 'video':
        # Quick Look autoplays. Its remote video controls are not exposed to AXe;
        # compare the moving fixture's central pixels, excluding system chrome.
        time.sleep(.8)
        ui.capture('video-playing')
        def frame_hash(name):
            return subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(Path(sys.argv[2]) / name),
                '-vf', 'crop=iw:ih/5:0:ih*0.45', '-f', 'framemd5', '-'], text=True).splitlines()[-1]
        assert frame_hash('video-preview.png') != frame_hash('video-playing.png'), 'Video frames did not advance'
    close()

ui.axe('tap', '--id', 'mcp-files:retry', '--post-delay', '.2')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('native.attachment.error.download') for item in items), 'Download failure was swallowed')
ui.capture('failed-download')
ui.axe('tap', '--label', catalog.text('native.attachment.preview.retry'), '--post-delay', '.2')
loaded()
ui.capture('retry-loaded')
close()
for file in ['missing', 'pending']:
    ui.axe('tap', '--id', 'mcp-files:' + file, '--post-delay', '.2')
    key = 'unavailable' if file == 'missing' else 'pending'
    ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('native.attachment.error.' + key) for item in items), 'Missing file state: ' + file)
    ui.capture(file)
    close()
ui.axe('tap', '--id', 'user-file:attachment:text', '--post-delay', '.2')
loaded()
ui.capture('user-file-preview')
close()
ui.axe('tap', '--id', 'mcp-files:cancel', '--post-delay', '.2')
ui.wait(lambda items: any(item.get('AXLabel') == catalog.text('native.attachment.preview.loading') for item in items), 'Loading state missing')
ui.capture('loading')
close()
time.sleep(4.5)
assert not any(item.get('AXUniqueId') == 'QLPreviewControllerView' for item in ui.state()), 'Cancelled download reopened the preview'
ui.capture('cancelled')
movie.unlink()
print('PASS: MCP text/PDF/video previews, playback, retry, unavailable/pending states, user attachments and cancelled download')
