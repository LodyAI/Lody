export type RendererReloadShortcutInput = {
  type: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
  isAutoRepeat: boolean
}

export function isRendererReloadShortcut(
  input: RendererReloadShortcutInput,
  platform: NodeJS.Platform
): boolean {
  const primaryModifier = platform === 'darwin' ? input.meta : input.control
  const secondaryModifier = platform === 'darwin' ? input.control : input.meta
  return (
    input.type === 'keyDown' &&
    input.code === 'KeyR' &&
    primaryModifier &&
    !secondaryModifier &&
    !input.alt &&
    !input.isAutoRepeat
  )
}
