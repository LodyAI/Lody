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
      (element) => element.getAttribute(attribute) === value
    )
    stableFrames = hasContent ? stableFrames + 1 : 0
    // Readiness comes from the target surface, never from loading/sidebar text.
    // Bound the cover so offline, navigation, and fatal-error recovery stay usable.
    if (stableFrames >= 2 || performance.now() - startedAt >= 5000) {
      onTargetPainted()
      return
    }
    requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}
