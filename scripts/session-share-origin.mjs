/** Resolve the public share-page origin for cloud client builds. */
export function resolveSessionShareOrigin(env) {
  const value = env.VITE_SESSION_SHARE_ORIGIN?.trim() || 'https://share.lody.ai';
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      value.includes('?') ||
      value.includes('#')
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('VITE_SESSION_SHARE_ORIGIN must be an HTTPS origin (HTTP loopback allowed)');
  }
}
