import type { runAcp } from 'acp-extension-claude';
import {
  assertManagedClaudeSettingsSafe,
  assertManagedClaudeSettingsValuesSafe,
} from './managed-claude-settings';

type Agent = ReturnType<typeof runAcp>['agent'];

/** Install before the connection can dispatch its first request. */
export function guardManagedClaudeAdapter(agent: Agent): void {
  const check = async (params: { cwd: string; _meta?: unknown }) => {
    const meta = params._meta;
    let settings: unknown;
    if (meta && typeof meta === 'object' && 'claudeCode' in meta) {
      const claude = meta.claudeCode;
      if (claude && typeof claude === 'object' && 'options' in claude) {
        const options = claude.options;
        if (options && typeof options === 'object') {
          if ('env' in options) assertManagedClaudeSettingsValuesSafe({ env: options.env });
          if ('settings' in options) settings = options.settings;
        }
      }
    }
    await assertManagedClaudeSettingsSafe(params.cwd, settings);
  };
  const newSession = agent.newSession.bind(agent);
  agent.newSession = async (params) => {
    await check(params);
    return newSession(params);
  };
  const loadSession = agent.loadSession.bind(agent);
  agent.loadSession = async (params) => {
    await check(params);
    return loadSession(params);
  };
  const resumeSession = agent.resumeSession.bind(agent);
  agent.resumeSession = async (params) => {
    await check(params);
    return resumeSession(params);
  };
  const forkSession = agent.unstable_forkSession.bind(agent);
  agent.unstable_forkSession = async (params) => {
    await check(params);
    return forkSession(params);
  };
  const prompt = agent.prompt.bind(agent);
  agent.prompt = async (params) => {
    const session = agent.sessions[params.sessionId];
    if (session) await check(session.creationParams ?? { cwd: session.cwd });
    return prompt(params);
  };
  const disableProvider = agent.unstable_disableProvider.bind(agent);
  agent.unstable_disableProvider = async (params) => {
    for (const session of Object.values(agent.sessions)) {
      await check(session.creationParams ?? { cwd: session.cwd });
    }
    return disableProvider(params);
  };
  const rejectAuthChange = async () => {
    throw new Error('Change managed account authentication through Lody account settings.');
  };
  agent.authenticate = rejectAuthChange;
  agent.unstable_setProvider = rejectAuthChange;
  agent.logout = rejectAuthChange;
}
