export function waitForTargetContentPainted(
  rootElement: HTMLElement,
  target: { workspace: string; sessionId?: string },
  onTargetPainted: () => void
): void {
  let stableFrames = 0
  const startedAt = performance.now()
  const attribute = target.sessionId ? 'data-window-session-ready' : 'data-window-workspace-ready'
  const value = target.sessionId ?? target.workspace
  const check = (): void => {
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

/** Observe invalidation as well as first readiness while a target stays hidden. */
export function observePreparedTarget(
  rootElement: HTMLElement,
  target: { workspace: string; sessionId?: string },
  changed: (ready: boolean) => void
): () => void {
  let frame = 0
  let stable = 0
  let reported = false
  let stopped = false
  const checkContent = (): boolean =>
    Array.from(rootElement.querySelectorAll('[data-window-session-ready]')).some(
      (element) =>
        element.getAttribute('data-window-session-ready') === target.sessionId &&
        (element.getAttribute('data-window-requires-stream') !== 'true' ||
          Array.from(rootElement.querySelectorAll('[data-window-session-stream-ready]')).some(
            (stream) => stream.getAttribute('data-window-session-stream-ready') === target.sessionId
          ))
    )
  const inspect = (): void => {
    if (stopped) return
    frame = 0
    const content = checkContent()
    if (!content) {
      stable = 0
      if (reported) {
        reported = false
        changed(false)
      }
    } else if (!reported) {
      if (++stable >= 2) {
        reported = true
        changed(true)
      } else frame = requestAnimationFrame(inspect)
    }
  }
  const observer = new MutationObserver(() => {
    // Revoke stale readiness before waiting for another animation frame.
    if (reported && !checkContent()) {
      reported = false
      stable = 0
      changed(false)
    }
    if (!frame && !reported) frame = requestAnimationFrame(inspect)
  })
  const resized = (): void => {
    stable = 0
    if (reported) {
      reported = false
      changed(false)
    }
    if (!frame) frame = requestAnimationFrame(inspect)
  }
  const view = rootElement.ownerDocument.defaultView
  view?.addEventListener('resize', resized)
  observer.observe(rootElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'data-window-session-ready',
      'data-window-requires-stream',
      'data-window-session-stream-ready'
    ]
  })
  frame = requestAnimationFrame(inspect)
  return () => {
    stopped = true
    observer.disconnect()
    view?.removeEventListener('resize', resized)
    cancelAnimationFrame(frame)
  }
}
