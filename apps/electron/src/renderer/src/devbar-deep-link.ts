export function isDevbarDeepLink(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === 'devbar' && url.searchParams.get('view') === 'main-thread'
  } catch {
    return false
  }
}
