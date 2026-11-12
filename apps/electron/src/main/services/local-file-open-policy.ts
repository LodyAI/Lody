import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

// Default handlers can execute scripts, shortcuts, installers and URL locators
// without execute bits. Unknown types must use Reveal or an explicit editor.
const MAC_BUNDLE_SUFFIX = /\.(?:app|workflow|scptd|bundle|plugin|kext|osax|action|pkg|mpkg)$/iu
const DOCUMENT_SUFFIXES = new Set([
  '.txt',
  '.md',
  '.mdx',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.pdf',
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.odp',
  '.pages',
  '.numbers',
  '.key',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.heic',
  '.bmp',
  '.tif',
  '.tiff',
  '.svg',
  '.mp3',
  '.mp4',
  '.m4a',
  '.m4v',
  '.wav',
  '.ogg',
  '.flac',
  '.webm',
  '.mov',
  '.avi'
])

async function isBundleDirectory(directory: string): Promise<boolean> {
  if (!MAC_BUNDLE_SUFFIX.test(basename(directory))) return false
  for (const marker of [join(directory, 'Contents', 'Info.plist'), join(directory, 'Info.plist')]) {
    try {
      if ((await stat(marker)).isFile()) return true
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        )
      )
        throw error
    }
  }
  return false
}

/** Return the checked real path, so callers never reopen the original symlink. */
export async function resolveOpenableLocalPath(
  targetPath: string,
  platform = process.platform
): Promise<string | null> {
  const resolved = await realpath(targetPath)
  const info = await stat(resolved)
  if (info.isDirectory()) {
    // Opening a directory asks the OS to handle that directory, not its ancestors.
    return platform === 'darwin' && MAC_BUNDLE_SUFFIX.test(basename(resolved)) ? null : resolved
  }
  if (!info.isFile() || !DOCUMENT_SUFFIXES.has(extname(resolved).toLowerCase())) return null
  if (platform === 'darwin') {
    for (let ancestor = dirname(resolved); ; ancestor = dirname(ancestor)) {
      if (await isBundleDirectory(ancestor)) return null
      if (dirname(ancestor) === ancestor) break
    }
  }
  // Known documents remain openable on 0777 volumes and with Git's executable bit.
  return resolved
}
