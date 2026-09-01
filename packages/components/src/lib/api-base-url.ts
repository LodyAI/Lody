function resolveApiBaseUrl(): string {
  // `import.meta.env` is a Vite-only global — it's `undefined` under other
  // bundlers (for example, the marketing preview that reuses these components),
  // so read it defensively rather than crashing at module evaluation time.
  const importMetaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const envValue = importMetaEnv?.VITE_SERVER_URL;
  if (envValue) return envValue;

  if (typeof window === 'undefined') {
    return 'https://lody.ai';
  }

  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return 'http://localhost:8787';
  }
  return window.location.origin;
}

export const API_BASE_URL = resolveApiBaseUrl();
