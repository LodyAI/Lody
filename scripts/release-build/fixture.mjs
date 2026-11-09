export function fixtureRequest(sourceSha, requestId = 'local-dry-run') {
  const env = {
    VITE_LODY_ENV: 'staging',
    VITE_SERVER_URL: 'https://server.example.invalid',
    VITE_CONVEX_SITE_URL: 'https://auth.example.invalid',
    VITE_CONVEX_DEPLOY_URL: 'https://auth.example.invalid',
    VITE_SITE_URL: 'https://site.example.invalid',
    VITE_SESSION_SHARE_ORIGIN: 'https://share.example.invalid',
    VITE_ELECTRON_UPDATE_URL: 'https://downloads.example.invalid/staging',
    VITE_ELECTRON_UPDATE_CHANNEL: 'next',
  };
  return {
    schemaVersion: 1,
    requestId,
    sourceSha,
    profile: { channel: 'staging', version: '0.110.0' },
    cliVersion: '0.110.0',
    embeddedCliVersion: '0.109.0',
    builtAt: '2026-11-09T00:00:00.000Z',
    targets: ['linux'],
    env,
    csp: {
      'connect-src': [env.VITE_SERVER_URL, env.VITE_CONVEX_SITE_URL],
      'img-src': [env.VITE_SERVER_URL],
      'frame-src': [],
    },
  };
}
