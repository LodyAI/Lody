export function waitForTargetContentPainted(
  rootElement: HTMLElement,
  target: { workspace: string; sessionId?: string },
  onTargetPainted: () => void
): void {
  let stableFrames = 0
  const startedAt = performance.now()
  const attribute = target.sessionId ? 'data-window-session-ready' : 'data-window-workspace-ready'
  const value = target.sessionId ?? target.workspace
  const check = () => {
    const hasContent = Array.from(rootElement.querySelectorAll(`[${attribute}]`)).some(
      (element) =>
        element.getAttribute(attribute) === value &&
        (element.getAttribute('data-window-requires-stream') !== 'true' ||
          Array.from(rootElement.querySelectorAll('[data-window-session-stream-ready]')).some(
            (stream) => stream.getAttribute('data-window-session-stream-ready') === value
          ))
    )
    stableFrames = hasContent ? stableFrames + 1 : 0
    // Main owns the recovery deadline; timeout is not a content-ready signal.
    if (stableFrames >= 2) {
      onTargetPainted()
      return
    }
    if (performance.now() - startedAt < 5000) requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}
