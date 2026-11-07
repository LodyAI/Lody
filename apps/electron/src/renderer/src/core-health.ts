export type HealthRoute = {
  pending: boolean
  pathname: string
  workspace?: string
  sessionId?: string
}
export function hasHealthyContent(root: ParentNode, route: HealthRoute): boolean {
  if (route.pending || root.querySelector('[data-lody-boot-shell]')) return false
  const matches = (attribute: string, value: string) =>
    Array.from(root.querySelectorAll(`[${attribute}]`)).some(
      (e) => e.getAttribute(attribute) === value
    )
  if (!route.workspace) return matches('data-core-entry-ready', route.pathname)
  if (!matches('data-core-workspace-ready', route.workspace)) return false
  if (!route.sessionId) return true
  return Array.from(root.querySelectorAll('[data-window-session-ready]')).some(
    (e) =>
      e.getAttribute('data-window-session-ready') === route.sessionId &&
      (e.getAttribute('data-window-requires-stream') !== 'true' ||
        matches('data-window-session-stream-ready', route.sessionId!))
  )
}
