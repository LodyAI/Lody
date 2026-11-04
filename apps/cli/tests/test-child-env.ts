const proxyKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'GLOBAL_AGENT_HTTP_PROXY',
  'GLOBAL_AGENT_HTTPS_PROXY',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'npm_config_proxy',
  'npm_config_https_proxy',
] as const;

/**
 * Child Node processes must not inherit the developer's terminal color or
 * proxy settings. The color pair prints a conflict warning and a proxy adds
 * UNDICI's EnvHttpProxyAgent warning to child stderr; several tests assert
 * exact stderr and must be independent of the invoking shell.
 */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const key of ['NO_COLOR', 'FORCE_COLOR', ...proxyKeys]) delete child[key];
  return child;
}
