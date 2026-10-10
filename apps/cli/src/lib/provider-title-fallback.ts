import {
  PROVIDER_OWNED_TITLE_FALLBACK_DELAY_MS,
  acpOwnsSessionTitleGeneration,
  shouldFallbackGenerateSessionTitle,
  type AgentConfigCliType,
  type AgentType,
  type BuiltinRuntimeOverrides,
  type CustomAcpLaunchSpec,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

/**
 * Safety net for a Session whose provider owns title generation but never
 * delivers a title: the adapter's own generation is best-effort and swallows
 * failures without signalling, so a Session still carrying its creation draft
 * — or no title at all — this long after a completed turn is titled by Lody's
 * isolated generator instead. The write guard the generator uses (`draft` or
 * missing only) keeps user renames and titles that did land safe, and a
 * provider title arriving later still replaces a locally generated one.
 */
export type ProviderTitleFallbackPorts = {
  /** The Session's current meta, or undefined when the Session is gone. */
  readSessionMeta: (
    sessionId: SessionId
  ) => Promise<Pick<SessionMeta, 'title' | 'titleSource' | 'agentConfigId'> | undefined>;
  /** The Agent config the Session runs on, or null when it cannot be read. */
  readAgentConfig: (agentConfigId: NonNullable<SessionMeta['agentConfigId']>) => Promise<{
    cliType: AgentConfigCliType;
    agentType: AgentType;
    env?: Record<string, string>;
    customAcp?: CustomAcpLaunchSpec;
    runtimeOverrides?: BuiltinRuntimeOverrides;
  } | null>;
  /** Whether the persisted capability cache records the runtime advertising
   * Core sessionTitle v1 for this Agent config. */
  readCachedSessionTitle: (agentConfigId: string) => Promise<boolean | undefined>;
  /** The Session's first user prompt: the same full text creation-time
   * generation would have used. */
  readFirstUserPrompt: (sessionId: SessionId) => Promise<string | undefined>;
  /** Run the isolated generator; it applies the same draft-only write guard. */
  generateIfMissing: (args: {
    sessionId: SessionId;
    cliType: AgentConfigCliType;
    agentType: AgentType;
    taskPrompt: string;
    env?: Record<string, string>;
    customAcp?: CustomAcpLaunchSpec;
    runtimeOverrides?: BuiltinRuntimeOverrides;
  }) => Promise<void>;
  /** Injected so tests advance time instead of sleeping. */
  schedule: (delayMs: number, run: () => void) => { cancel: () => void };
};

export type ProviderTitleFallback = {
  /** Called from turn finalization: schedule the fallback check if this
   * Session's provider owns titles and the title is still missing/draft. */
  scheduleFromTurnEnd: (sessionId: SessionId) => Promise<void>;
  /** Cancel every pending check (daemon cleanup). */
  dispose: () => void;
};

type SessionOwnershipState = {
  ownsTitle: boolean;
  meta: Pick<SessionMeta, 'title' | 'titleSource'> | undefined;
  provider: NonNullable<Awaited<ReturnType<ProviderTitleFallbackPorts['readAgentConfig']>>>;
};

export function createProviderTitleFallback(
  ports: ProviderTitleFallbackPorts
): ProviderTitleFallback {
  const pending = new Map<SessionId, { cancel: () => void }>();

  const readOwnership = async (
    sessionId: SessionId
  ): Promise<SessionOwnershipState | undefined> => {
    const meta = await ports.readSessionMeta(sessionId);
    if (!meta?.agentConfigId) return undefined;
    const provider = await ports.readAgentConfig(meta.agentConfigId);
    if (!provider) return undefined;
    const advertised = await ports.readCachedSessionTitle(meta.agentConfigId);
    return {
      provider,
      meta,
      ownsTitle: acpOwnsSessionTitleGeneration(
        provider.cliType,
        provider.agentType,
        provider.runtimeOverrides,
        advertised
      ),
    };
  };

  const runFallback = async (sessionId: SessionId): Promise<void> => {
    pending.delete(sessionId);
    const state = await readOwnership(sessionId);
    if (!state || !shouldFallbackGenerateSessionTitle(state.meta, state.ownsTitle)) return;
    const taskPrompt = await ports.readFirstUserPrompt(sessionId);
    if (!taskPrompt?.trim()) return;
    await ports.generateIfMissing({
      sessionId,
      cliType: state.provider.cliType,
      agentType: state.provider.agentType,
      taskPrompt,
      env: state.provider.env,
      customAcp: state.provider.customAcp,
      runtimeOverrides: state.provider.runtimeOverrides,
    });
  };

  return {
    scheduleFromTurnEnd: async (sessionId) => {
      const state = await readOwnership(sessionId);
      if (!state || !shouldFallbackGenerateSessionTitle(state.meta, state.ownsTitle)) return;
      // A turn ending while a check is already pending leaves the earliest
      // deadline in place; re-arming here would let a chatty Session defer
      // the fallback forever.
      if (pending.has(sessionId)) return;
      const timer = ports.schedule(PROVIDER_OWNED_TITLE_FALLBACK_DELAY_MS, () => {
        void runFallback(sessionId);
      });
      pending.set(sessionId, timer);
    },
    dispose: () => {
      for (const timer of pending.values()) timer.cancel();
      pending.clear();
    },
  };
}
