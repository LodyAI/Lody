"""Native toast semantics, including real archive/restore success and write failure."""
import subprocess
import sys
from driver import UI
import catalog

ui = UI(sys.argv[1], sys.argv[2])
width = round(ui.state()[0]['frame']['width'])

for scene, key, color in [
    ('toast-archive', 'session.toast.archived', 'neutral'),
    ('toast-unarchive', 'session.toast.unarchived', 'neutral'),
    ('toast-error', 'session.toast.archiveFailed', 'error'),
    ('toast-warning', 'create.toast.branchRequired', 'warning'),
    ('toast-info', 'diff.toast.copied', 'neutral'),
]:
    ui.open_case(scene)
    expected = catalog.text(key)
    toast = ui.wait(lambda items: next((i for i in items if i.get('AXUniqueId') == 'lody.toast'
                    and i.get('AXLabel') == expected), None), 'Missing toast: ' + expected)
    frame = toast['frame']
    ui.screenshot(scene)
    x = round(frame['x'] + 14)
    y = round(frame['y'] + (frame['height'] - 26) / 2)
    counts = subprocess.check_output([
        'swift', '-e', '''
import AppKit
let args = CommandLine.arguments
let image = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: args[1])))!
let scale = Double(image.pixelsWide) / Double(args[2])!
let x = Int(args[3])!, y = Int(args[4])!
var red = 0, orange = 0
for py in y..<(y + 26) {
  for px in x..<(x + 26) {
    let color = image.colorAt(x: Int(Double(px) * scale), y: Int(Double(py) * scale))!.usingColorSpace(.deviceRGB)!
    let r = color.redComponent * 255, g = color.greenComponent * 255, b = color.blueComponent * 255
    if r > g + 35 && r > b + 35 { red += 1 }
    if r > g + 20 && g > b + 20 { orange += 1 }
  }
}
print(red, orange)
''', str(ui.output / (scene + '.png')), str(width), str(x), str(y),
    ], text=True, timeout=60)
    red, orange = map(int, counts.split())
    if color == 'neutral':
        assert red < 4 and orange < 4, (scene, red, orange)
    elif color == 'error':
        assert red >= 4, (scene, red)
    else:
        assert orange >= 4, (scene, orange)
    ui.wait(lambda items: not any(i.get('AXUniqueId') == 'lody.toast' for i in items),
            'Toast did not expire')
    print('PASS:', scene, 'localized accessible message,', color, 'glyph and automatic dismissal', flush=True)
