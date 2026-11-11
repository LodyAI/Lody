import { realpath, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'

// OS default handlers may execute these files instead of displaying them.
const EXECUTABLE_SUFFIX =
  /\.(?:app|command|sh|bash|zsh|fish|exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|cpl|lnk|url|desktop|appimage|workflow|scpt|scptd|jar|py|rb|pl)$/iu

const MAC_BUNDLE_SUFFIX = /\.(?:app|workflow|scptd|bundle|plugin|kext|osax|action)$/iu
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

export async function canOpenLocalPath(
  targetPath: string,
  platform = process.platform
): Promise<boolean> {
  const resolved = await realpath(targetPath)
  const paths = [targetPath, resolved]
  // A directory named github.com or three.js is not an executable file.
  if (
    platform === 'darwin' &&
    paths.some((value) => value.split(/[\\/]/u).some((part) => MAC_BUNDLE_SUFFIX.test(part)))
  )
    return false
  const info = await stat(resolved)
  if (info.isDirectory()) return true
  if (paths.some((value) => EXECUTABLE_SUFFIX.test(basename(value)))) return false
  // Removable/network volumes and Git can mark ordinary documents executable.
  // Inspect the real target's extension so an innocent symlink cannot hide a binary.
  return (
    info.isFile() &&
    ((info.mode & 0o111) === 0 || DOCUMENT_SUFFIXES.has(extname(resolved).toLowerCase()))
  )
}
