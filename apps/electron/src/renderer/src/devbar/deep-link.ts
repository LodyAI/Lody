export function isDevbarDeepLink(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return false
    return url.hostname === 'devbar' && url.searchParams.get('view') === 'main-thread'
  } catch {
    return false
  }
}
