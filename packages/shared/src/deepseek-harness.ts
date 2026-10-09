/** Compatibility re-export; the extension package owns this selector vocabulary. */
export {
  DEEPSEEK_HARNESS_AGENT_PRESETS,
  DEEPSEEK_HARNESS_API_KEY_ENV,
  DEEPSEEK_HARNESS_BASE_URL_ENV,
  DEEPSEEK_HARNESS_PERMISSION_MODES,
} from 'acp-extension-dsh/capabilities';

/** Stable native config location on the owning machine; independent of provider names. */
export function getDeepSeekHarnessProviderHome(dataRoot: string, providerId: string): string {
  if (!providerId) throw new Error('DSH requires a Provider ID');
  const component = encodeURIComponent(providerId).replace(/\./g, '%2E');
  const separator = dataRoot.includes('\\') ? '\\' : '/';
  return [dataRoot.replace(/[\\/]+$/, ''), 'dsh', 'providers', component].join(separator);
}

export function getDeepSeekHarnessProviderConfigPath(dataRoot: string, providerId: string): string {
  const home = getDeepSeekHarnessProviderHome(dataRoot, providerId);
  const separator = home.includes('\\') ? '\\' : '/';
  return [home, 'profiles', 'lody-acp', 'cordis.patch.yml'].join(separator);
}
