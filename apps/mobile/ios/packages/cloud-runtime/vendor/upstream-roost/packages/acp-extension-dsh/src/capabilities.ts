/**
 * Permission vocabulary shared by the ACP selector and the generated Harness
 * profile. `id`/`name`/`description` are the client-facing labels a host
 * renders; `sandbox`/`approval` are the Harness preset the profile writes into
 * `cordis.patch.yml`. Both halves live here so the selector a host shows and
 * the preset Harness enforces cannot drift apart.
 */
export const DEEPSEEK_HARNESS_PERMISSION_PRESETS = [
  {
    id: 'read-only',
    name: 'Read-only',
    description: 'Read inside the workspace; protected writes require one-time approval.',
    sandbox: 'read-only',
    approval: 'ask',
  },
  {
    id: 'workspace-write',
    name: 'Workspace write',
    description: 'Read and write inside the workspace; wider access requires one-time approval.',
    sandbox: 'workspace-write',
    approval: 'ask',
  },
  {
    id: 'danger-full-access',
    name: 'Full access',
    description: 'Allow unrestricted file and command access without approval prompts.',
    sandbox: 'danger-full-access',
    approval: 'never',
  },
] as const;

/** Permission preset a fresh session starts on. Must name one of the presets above. */
export const DEEPSEEK_HARNESS_DEFAULT_PERMISSION_PRESET = 'workspace-write';

/** Stable ACP selector vocabulary backed by the composed DeepSeek Harness profile. */
export const DEEPSEEK_HARNESS_PERMISSION_MODES = DEEPSEEK_HARNESS_PERMISSION_PRESETS.map(
  ({ id, name, description }) => ({ id, name, description })
);

/** Upstream DeepSeek connection settings consumed by the provider and ACP discovery. */
export const DEEPSEEK_HARNESS_API_KEY_ENV = 'DEEPSEEK_API_KEY';
export const DEEPSEEK_HARNESS_BASE_URL_ENV = 'DEEPSEEK_BASE_URL';

/** Official Chat-era aliases are upgraded only on this exact HTTPS authority. */
export const DEEPSEEK_HARNESS_OFFICIAL_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEEPSEEK_HARNESS_OFFICIAL_BASE_URL_PATTERN =
  /^https:\/\/api\.deepseek\.com(?::443)?(?:\/(?:v1|anthropic(?:\/v1)?))?\/*$/i;

export function isDeepSeekOfficialBaseUrl(value: string | undefined): boolean {
  return DEEPSEEK_HARNESS_OFFICIAL_BASE_URL_PATTERN.test(value?.trim() ?? '');
}

/** Built-in agent compositions shipped by the official DeepSeek Harness CLI. */
export const DEEPSEEK_HARNESS_AGENT_PRESETS = [
  {
    value: 'standard',
    name: 'Standard mode',
    description:
      'Full coding agent with file editing, shell, search, skills, planning, goals, subagents, and workflows.',
  },
  {
    value: 'ptc',
    name: 'PTC mode',
    description:
      'Full coding agent without the workflow tools; other tools are exposed through the PTC SDK so one TypeScript program composes multi-step work.',
  },
  {
    value: 'minimal',
    name: 'Minimal mode',
    description: 'Single-tool coding agent with a persistent shell.',
  },
  {
    value: 'cordis',
    name: 'Creator mode',
    description:
      'Standard capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
  },
] as const;
