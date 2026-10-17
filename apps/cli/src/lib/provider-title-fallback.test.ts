import { describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import {
  createProviderTitleFallback,
  type ProviderTitleFallbackPorts,
} from './provider-title-fallback';

type FakeSession = {
  title?: string;
  titleSource?: string;
  agentConfigId?: string;
};

type FakeConfig = {
  cliType: 'builtin' | 'custom';
  agentType: string;
  env?: Record<string, string>;
  runtimeOverrides?: Record<string, string>;
};

/** Manual clock: tasks fire on advance(), cancelled ones never run; each
 * advance drains the microtask queue so the async check settles before the
 * assertion that follows it. */
const createManualClock = () => {
  const tasks: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  let now = 0;
  return {
    schedule: (delayMs: number, run: () => void) => {
      const task = { at: now + delayMs, run, cancelled: false };
      tasks.push(task);
      return { cancel: () => (task.cancelled = true) };
    },
    advance: async (ms: number) => {
      now += ms;
      const firing = tasks.filter((task) => !task.cancelled && task.at <= now);
      for (const task of firing) {
        task.cancelled = true;
        task.run();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    pendingCount: () => tasks.filter((task) => !task.cancelled).length,
  };
};

const createPorts = (overrides: Partial<ProviderTitleFallbackPorts> = {}) => {
  const sessions = new Map<string, FakeSession>();
  const configs = new Map<string, FakeConfig>();
  const cachedSessionTitle = new Map<string, boolean>();
  const firstUserPrompts = new Map<string, string>();
  const generate = vi.fn(async () => undefined);
  const ports: ProviderTitleFallbackPorts = {
    readSessionMeta: async (sessionId) => sessions.get(sessionId),
    readAgentConfig: async (agentConfigId) => configs.get(agentConfigId) ?? null,
    readCachedSessionTitle: async (agentConfigId) => cachedSessionTitle.get(agentConfigId),
    readFirstUserPrompt: async (sessionId) => firstUserPrompts.get(sessionId),
    generateIfMissing: generate,
    schedule: () => {
      throw new Error('schedule must be injected by the test');
    },
    ...overrides,
  };
  return { ports, sessions, configs, cachedSessionTitle, firstUserPrompts, generate };
};

const SESSION = 'session-1' as SessionId;
const claudeDraftSession: FakeSession = {
  title: '你是实现角色，只处理明确范围内的代码和测试。',
  titleSource: 'draft',
  agentConfigId: 'config-1',
};

describe('createProviderTitleFallback', () => {
  it('generates a title for a provider-owned session still on its creation draft', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, firstUserPrompts, generate } =
      createPorts({ schedule: clock.schedule });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', { cliType: 'builtin', agentType: 'claude', env: { KEY: 'value' } });
    cachedSessionTitle.set('config-1', true);
    firstUserPrompts.set(SESSION, '你是实现角色…\n\nFix the login flow');

    const fallback = createProviderTitleFallback(ports);
    await fallback.scheduleFromTurnEnd(SESSION);
    expect(generate).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(90_001);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({
      sessionId: SESSION,
      cliType: 'builtin',
      agentType: 'claude',
      taskPrompt: '你是实现角色…\n\nFix the login flow',
      env: { KEY: 'value' },
      customAcp: undefined,
      runtimeOverrides: undefined,
    });
  });

  it('never arms for a session whose provider does not own its title', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, generate } = createPorts({
      schedule: clock.schedule,
    });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', { cliType: 'builtin', agentType: 'kimi' });
    cachedSessionTitle.set('config-1', false);

    await createProviderTitleFallback(ports).scheduleFromTurnEnd(SESSION);
    expect(clock.pendingCount()).toBe(0);
    await clock.advance(90_001);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not generate when the provider delivered a title inside the window', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, firstUserPrompts, generate } =
      createPorts({ schedule: clock.schedule });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', { cliType: 'builtin', agentType: 'claude' });
    cachedSessionTitle.set('config-1', true);
    firstUserPrompts.set(SESSION, 'Fix the login flow');

    const fallback = createProviderTitleFallback(ports);
    await fallback.scheduleFromTurnEnd(SESSION);
    // The provider's pushed title lands a few seconds into the grace period.
    await clock.advance(5_000);
    sessions.set(SESSION, {
      title: 'Provider title',
      titleSource: 'generated',
      agentConfigId: 'config-1',
    });
    await clock.advance(90_001);
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not generate over a user rename that landed inside the window', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, generate } = createPorts({
      schedule: clock.schedule,
    });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', { cliType: 'builtin', agentType: 'claude' });
    cachedSessionTitle.set('config-1', true);

    await createProviderTitleFallback(ports).scheduleFromTurnEnd(SESSION);
    await clock.advance(5_000);
    sessions.set(SESSION, {
      title: 'Renamed by hand',
      titleSource: 'user',
      agentConfigId: 'config-1',
    });
    await clock.advance(90_001);
    expect(generate).not.toHaveBeenCalled();
  });

  it('also titles a provider-owned session that has no title at all', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, firstUserPrompts, generate } =
      createPorts({ schedule: clock.schedule });
    sessions.set(SESSION, { agentConfigId: 'config-1' });
    configs.set('config-1', { cliType: 'builtin', agentType: 'codex' });
    firstUserPrompts.set(SESSION, 'Review the diff');

    await createProviderTitleFallback(ports).scheduleFromTurnEnd(SESSION);
    await clock.advance(90_001);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: 'codex', taskPrompt: 'Review the diff' })
    );
  });

  it('keeps the earliest deadline when another turn ends while a check is pending', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, firstUserPrompts, generate } =
      createPorts({ schedule: clock.schedule });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', { cliType: 'builtin', agentType: 'claude' });
    cachedSessionTitle.set('config-1', true);
    firstUserPrompts.set(SESSION, 'Fix the login flow');

    const fallback = createProviderTitleFallback(ports);
    await fallback.scheduleFromTurnEnd(SESSION);
    await clock.advance(30_000);
    await fallback.scheduleFromTurnEnd(SESSION);
    expect(clock.pendingCount()).toBe(1);

    await clock.advance(60_001);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('skips generation when the first user prompt holds nothing to name the session from', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, firstUserPrompts, generate } =
      createPorts({ schedule: clock.schedule });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', { cliType: 'builtin', agentType: 'claude' });
    cachedSessionTitle.set('config-1', true);
    firstUserPrompts.set(SESSION, '   ');

    await createProviderTitleFallback(ports).scheduleFromTurnEnd(SESSION);
    await clock.advance(90_001);
    expect(generate).not.toHaveBeenCalled();
  });

  it('treats an overridden runtime as not provider-owned, matching the create-time gate', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, generate } = createPorts({
      schedule: clock.schedule,
    });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', {
      cliType: 'builtin',
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/opt/old-claude' },
    });
    cachedSessionTitle.set('config-1', false);

    await createProviderTitleFallback(ports).scheduleFromTurnEnd(SESSION);
    expect(clock.pendingCount()).toBe(0);
    await clock.advance(90_001);
    expect(generate).not.toHaveBeenCalled();
  });

  it('cancel() from dispose stops every pending check', async () => {
    const clock = createManualClock();
    const { ports, sessions, configs, cachedSessionTitle, generate } = createPorts({
      schedule: clock.schedule,
    });
    sessions.set(SESSION, { ...claudeDraftSession });
    configs.set('config-1', { cliType: 'builtin', agentType: 'claude' });
    cachedSessionTitle.set('config-1', true);

    const fallback = createProviderTitleFallback(ports);
    await fallback.scheduleFromTurnEnd(SESSION);
    fallback.dispose();
    expect(clock.pendingCount()).toBe(0);
    await clock.advance(90_001);
    expect(generate).not.toHaveBeenCalled();
  });
});
