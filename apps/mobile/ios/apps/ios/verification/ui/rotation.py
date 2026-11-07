"""Hardware orientation and app width class for leased Simulators, without Simulator.app.

Orientation goes through the device's PurpleWorkspacePort (orientation.m); the
width class goes through LodyVerifyWidth, which the app honours only under --ui-verify."""
import hashlib
import subprocess
import tempfile
import time
from pathlib import Path

SOURCE = Path(__file__).with_name('orientation.m')


def landscape(items):
    frame = items[0]['frame']
    return frame['width'] > frame['height']


def tool():
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()[:12]
    binary = Path(tempfile.gettempdir()) / f'lody-orientation-{digest}'
    if not binary.exists():
        subprocess.run(['xcrun', 'clang', '-fobjc-arc', '-framework', 'Foundation', str(SOURCE), '-o', str(binary)],
                       check=True, capture_output=True, timeout=120)
    return binary


def rotate(ui, orientation):
    subprocess.run([str(tool()), ui.udid, orientation], check=True, capture_output=True, timeout=20)
    wide = orientation == 'landscape'
    ui.wait(lambda items: landscape(items) == wide or None, f'The app did not rotate to {orientation}')
    time.sleep(1)


def restore_portrait(ui):
    rotate(ui, 'portrait')


def set_width(ui, width):
    subprocess.run(['xcrun', 'simctl', 'spawn', ui.udid, 'notifyutil', '-p', f'ai.lody.mobile.verify.width.{width}'],
                   check=True, capture_output=True, timeout=20)
    time.sleep(1.5)
