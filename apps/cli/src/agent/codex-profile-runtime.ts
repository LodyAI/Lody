export { registerCodexProfileProcess } from './codex-profile-process-usage';
import { getCodexProfileStore, type ResolvedCodexProfile } from './codex-profile-store';
import { startCodexCredentialBroker } from './codex-credential-broker';

export type CodexProfileExecution = {
  profile: ResolvedCodexProfile;
  /** Candidate key lives only through the verification process. */
  candidateKey?: string;
};

export function codexProfileConfig(
  profile: ResolvedCodexProfile,
  baseUrl?: string
): Record<string, unknown> {
  const base = {
    cli_auth_credentials_store: 'keyring',
    check_for_update_on_startup: false,
    shell_environment_policy: {
      inherit: 'all',
      exclude: ['LODY_CODEX_API_KEY'],
    },
  };
  if (profile.profile.mode === 'chatgpt') {
    return {
      ...base,
      forced_login_method: 'chatgpt',
      model_provider: 'openai',
      model_providers: {},
    };
  }
  return {
    ...base,
    model_provider: 'lody',
    model_providers: {
      lody: {
        name: 'Lody custom endpoint',
        base_url: baseUrl ?? 'http://127.0.0.1:1',
        env_key: 'LODY_CODEX_API_KEY',
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
  };
}

export function codexProfileEnvironment(
  profile: ResolvedCodexProfile,
  inherited: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      /^(CODEX_|OPENAI_|LODY_CODEX_|DYLD_|MODEL_PROVIDER$|DEFAULT_AUTH_REQUEST$|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$)/i.test(
        key
      )
    )
      delete env[key];
  }
  const config = JSON.stringify(codexProfileConfig(profile));
  return {
    ...env,
    CODEX_HOME: profile.home,
    CODEX_CONFIG: config,
    LODY_CODEX_PROFILE_CONFIG: config,
  };
}

export async function codexProfileSpawnEnvironment(
  execution: CodexProfileExecution,
  inherited: NodeJS.ProcessEnv
): Promise<{ env: NodeJS.ProcessEnv; close: () => Promise<void> }> {
  if (!execution.candidateKey && !(await getCodexProfileStore().isReady(execution.profile)))
    throw new Error('This Codex account is not ready; authenticate this provider again');
  const env = codexProfileEnvironment(execution.profile, inherited);
  // CODEX_PATH is resolved by Lody's managed-runtime owner after user env validation.
  if (inherited.CODEX_PATH) env.CODEX_PATH = inherited.CODEX_PATH;
  if (execution.profile.profile.mode === 'api-key') {
    const broker = await startCodexCredentialBroker({
      baseUrl: execution.profile.profile.baseUrl,
      apiKey: execution.candidateKey ?? (await getCodexProfileStore().apiKey(execution.profile)),
    });
    const config = JSON.stringify(codexProfileConfig(execution.profile, broker.baseUrl));
    env.CODEX_CONFIG = config;
    env.LODY_CODEX_PROFILE_CONFIG = config;
    env.LODY_CODEX_API_KEY = broker.capability;
    return { env, close: broker.close };
  }
  return { env, close: async () => {} };
}
