import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Use the system Objective-C bridge; no runtime compiler or downloaded helper.
// Paths are argv, never executable script text. This changes Finder's custom icon,
// not the signed icon resources or Info.plist inside Contents.
const script = `
ObjC.import('AppKit');
function run(args) {
  var image = args[1] ? $.NSImage.alloc.initWithContentsOfFile(args[1]) : $();
  if (args[1] && (!image || image.isNil())) throw new Error('Invalid icon image');
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, args[0], 0)) {
    throw new Error('Unable to change application icon');
  }
}
`

export async function setMacApplicationIcon(bundlePath: string, imagePath: string | null) {
  await execFileAsync(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', script, bundlePath, imagePath ?? ''],
    {
      timeout: 15_000,
      maxBuffer: 64 * 1024
    }
  )
}
