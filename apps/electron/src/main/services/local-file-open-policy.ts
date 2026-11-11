import { realpath, stat } from 'node:fs/promises'

// OS default handlers may execute these files instead of displaying them.
const EXECUTABLE_SUFFIX =
  /\.(?:app|command|sh|bash|zsh|fish|exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|cpl|lnk|url|desktop|appimage|workflow|scpt|scptd|jar|py|rb|pl)$/iu

export async function canOpenLocalPath(targetPath: string): Promise<boolean> {
  const resolved = await realpath(targetPath)
  if (
    [targetPath, resolved].some((value) =>
      value.split(/[\\/]/u).some((part) => EXECUTABLE_SUFFIX.test(part))
    )
  )
    return false
  const info = await stat(resolved)
  // Directory execute bits mean traversal; only regular files use them for execution.
  return info.isDirectory() || (info.isFile() && (info.mode & 0o111) === 0)
}
