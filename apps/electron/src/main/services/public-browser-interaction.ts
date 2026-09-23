import type { WebContents } from 'electron'

/** Forward ownership signals only, never page contents or typed keys. */
export function observePublicBrowserInteraction(
  contents: Pick<WebContents, 'on' | 'removeListener'>,
  publish: (source: 'pointer' | 'keyboard') => void
): () => void {
  let lastPoint: { x: number; y: number } | null = null
  const onMouse = (_event: unknown, mouse: Electron.MouseInputEvent) => {
    if (mouse.type === 'mouseLeave') lastPoint = null
    if (mouse.type !== 'mouseMove' && mouse.type !== 'mouseDown') return
    const moved = !lastPoint || lastPoint.x !== mouse.x || lastPoint.y !== mouse.y
    lastPoint = { x: mouse.x, y: mouse.y }
    if (
      mouse.type === 'mouseMove' &&
      (!moved || mouse.modifiers?.some((key) => key.endsWith('ButtonDown')))
    )
      return
    publish('pointer')
  }
  const onKey = (_event: unknown, input: Electron.Input) => {
    // Menu accelerators, especially close, must preserve a newer renderer
    // pointer choice instead of reclaiming the native view's old keyboard focus.
    if (input.type !== 'keyDown' || input.meta || input.control) return
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(input.key)) return
    publish('keyboard')
  }
  contents.on('before-mouse-event', onMouse)
  contents.on('before-input-event', onKey)
  return () => {
    contents.removeListener('before-mouse-event', onMouse)
    contents.removeListener('before-input-event', onKey)
  }
}
