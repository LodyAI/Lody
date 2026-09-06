import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardManagedClaudeAdapter } from './managed-claude-adapter';

const settings = vi.hoisted(() => ({ check: vi.fn(), values: vi.fn() }));
vi.mock('./managed-claude-settings', () => ({
  assertManagedClaudeSettingsSafe: settings.check,
  assertManagedClaudeSettingsValuesSafe: settings.values,
}));

type Agent = Parameters<typeof guardManagedClaudeAdapter>[0];
type CreationParams = Agent['sessions'][string]['creationParams'];

function harness() {
  const events: string[] = [];
  const originals = {
    newSession: vi.fn<Agent['newSession']>(async () => {
      events.push('new');
      return { sessionId: 'created' };
    }),
    loadSession: vi.fn<Agent['loadSession']>(async () => {
      events.push('load');
      return {};
    }),
    resumeSession: vi.fn<Agent['resumeSession']>(async () => {
      events.push('resume');
      return {};
    }),
    unstable_forkSession: vi.fn<Agent['unstable_forkSession']>(async () => {
      events.push('fork');
      return { sessionId: 'forked' };
    }),
    prompt: vi.fn<Agent['prompt']>(async () => {
      events.push('prompt');
      return { stopReason: 'end_turn' };
    }),
    unstable_disableProvider: vi.fn<Agent['unstable_disableProvider']>(async () => {
      events.push('disable');
      return {};
    }),
    authenticate: vi.fn<Agent['authenticate']>(async () => ({})),
    unstable_setProvider: vi.fn<Agent['unstable_setProvider']>(async () => ({})),
    logout: vi.fn<Agent['logout']>(async () => {}),
  };
  const sessions: Record<string, { creationParams: CreationParams }> = {};
  // The guard reads only creationParams and wraps these methods; no native SDK is started.
  const agent = { ...originals, sessions } as unknown as Agent;
  settings.check.mockImplementation(async (cwd: string) => {
    events.push(`check:${cwd}`);
  });
  guardManagedClaudeAdapter(agent);
  return { agent, originals, sessions, events };
}

describe('managed Claude adapter guard', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ['newSession', 'new'],
    ['loadSession', 'load'],
    ['resumeSession', 'resume'],
    ['unstable_forkSession', 'fork'],
  ] as const)('checks cwd before %s and stops it on unsafe settings', async (method, event) => {
    const h = harness();
    const params = { sessionId: 'existing', cwd: '/project', mcpServers: [] };
    await h.agent[method](params);
    expect(h.events).toEqual(['check:/project', event]);
    expect(h.originals[method]).toHaveBeenCalledWith(params);
    h.events.length = 0;
    settings.check.mockRejectedValueOnce(new Error('Unsafe settings'));
    await expect(h.agent[method](params)).rejects.toThrow('Unsafe settings');
    expect(h.events).toEqual([]);
  });

  it('rechecks the existing session creation settings before each prompt', async () => {
    const h = harness();
    const creationParams = {
      cwd: '/original-project',
      mcpServers: [],
      _meta: { claudeCode: { options: { settings: { model: 'first' } } } },
    };
    h.sessions.existing = { creationParams };
    const params = { sessionId: 'existing', prompt: [{ type: 'text' as const, text: 'hello' }] };
    await h.agent.prompt(params);
    expect(settings.check).toHaveBeenLastCalledWith('/original-project', { model: 'first' });
    expect(h.events).toEqual(['check:/original-project', 'prompt']);

    creationParams._meta.claudeCode.options.settings.model = 'changed';
    settings.check.mockRejectedValueOnce(new Error('Changed project settings'));
    h.events.length = 0;
    await expect(h.agent.prompt(params)).rejects.toThrow('Changed project settings');
    expect(settings.check).toHaveBeenLastCalledWith('/original-project', { model: 'changed' });
    expect(h.events).toEqual([]);
  });

  it('checks all live sessions before disabling the provider and rejects on any unsafe session', async () => {
    const h = harness();
    h.sessions.first = { creationParams: { cwd: '/first', mcpServers: [] } };
    h.sessions.second = { creationParams: { cwd: '/second', mcpServers: [] } };
    await h.agent.unstable_disableProvider({ providerId: 'main' });
    expect(h.events).toEqual(['check:/first', 'check:/second', 'disable']);
    h.events.length = 0;
    settings.check.mockImplementation(async (cwd: string) => {
      h.events.push(`check:${cwd}`);
      if (cwd === '/second') throw new Error('Unsafe second session');
    });
    await expect(h.agent.unstable_disableProvider({ providerId: 'main' })).rejects.toThrow(
      'Unsafe second session'
    );
    expect(h.events).toEqual(['check:/first', 'check:/second']);
  });

  it('rejects in-adapter authenticate, provider replacement, and logout', async () => {
    const h = harness();
    const error = 'Change managed account authentication through Lody account settings.';
    await expect(h.agent.authenticate({ methodId: 'oauth' })).rejects.toThrow(error);
    await expect(
      h.agent.unstable_setProvider({
        providerId: 'main',
        apiType: 'anthropic',
        baseUrl: 'https://synthetic.example.test',
      })
    ).rejects.toThrow(error);
    await expect(h.agent.logout({})).rejects.toThrow(error);
    expect(h.originals.authenticate).not.toHaveBeenCalled();
    expect(h.originals.unstable_setProvider).not.toHaveBeenCalled();
    expect(h.originals.logout).not.toHaveBeenCalled();
  });

  it('validates metadata env before settings and forwards safe metadata unchanged', async () => {
    const h = harness();
    const env = { SAFE_OPTION: 'synthetic' };
    const inlineSettings = { model: 'synthetic-model' };
    const params = {
      cwd: '/project',
      mcpServers: [],
      _meta: { claudeCode: { options: { env, settings: inlineSettings } } },
    };
    settings.values.mockImplementation(() => h.events.push('env'));
    await expect(h.agent.newSession(params)).resolves.toEqual({ sessionId: 'created' });
    expect(settings.values).toHaveBeenCalledWith({ env });
    expect(settings.check).toHaveBeenCalledWith('/project', inlineSettings);
    expect(h.events).toEqual(['env', 'check:/project', 'new']);
    expect(h.originals.newSession).toHaveBeenCalledWith(params);

    h.events.length = 0;
    settings.values.mockImplementationOnce(() => {
      throw new Error('Unsafe metadata env');
    });
    await expect(h.agent.newSession(params)).rejects.toThrow('Unsafe metadata env');
    expect(h.events).toEqual([]);
  });
});
