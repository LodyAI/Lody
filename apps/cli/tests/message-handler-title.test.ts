import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as codexProfiles from '../src/agent/codex-profile-store';
import { MessageHandler } from '../src/lib/message-handler';
import type { Logger } from '../src/utils/logger';
import type { AgentConfigMeta, SessionId, SessionTitleSource } from '@lody/shared';
import type { SessionManager } from '../src/session/session-manager';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import { createTestCloudPort } from './test-cloud-port';

vi.mock('@/agent/title-generator', async () => {
  const actual =
    await vi.importActual<typeof import('@/agent/title-generator')>('@/agent/title-generator');
  return {
    ...actual,
    generateTitleIsolated: vi.fn(async () => 'Generated Title'),
  };
});

import { generateTitleIsolated } from '@/agent/title-generator';

const mockedGenerateTitleIsolated = vi.mocked(generateTitleIsolated);

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createHandler = async (
  metaTitle?: string | null,
  titleSource?: SessionTitleSource,
  latestMeta?: { title?: string; titleSource?: SessionTitleSource },
  options?: {
    agentConfigId?: string;
    agentConfigMeta?: Partial<AgentConfigMeta> | null;
  }
) => {
  const logger = createSilentLogger();

  const sessionDoc = {
    getMetaState: vi
      .fn()
      .mockResolvedValueOnce({
        title: metaTitle ?? undefined,
        titleSource,
        agentConfigId: options?.agentConfigId,
      })
      .mockResolvedValue(latestMeta ?? { title: metaTitle ?? undefined, titleSource }),
    setTitle: vi.fn(async () => {}),
    setTitleIfSourceIn: vi.fn(async (_t: string, _s: string, allowed: string[]) => {
      const latest = latestMeta ?? { title: metaTitle ?? undefined, titleSource };
      const currentTitle = latest.title?.trim();
      const currentSource = latest.titleSource;
      return !(currentTitle && currentSource && !allowed.includes(currentSource));
    }),
  };

  const workspaceDocument = {
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
    registerMachine: vi.fn(),
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
    },
    getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
    getAgentConfigById: vi.fn(async () => options?.agentConfigMeta ?? null),
  };

  const sessionManager = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(),
    finishSession: vi.fn(),
    cleanUp: vi.fn(),
    setSessionError: vi.fn(),
    terminateSession: vi.fn(),
    hasSession: vi.fn(),
    initialize: vi.fn(),
    createSession: vi.fn(),
  };

  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    logger,
    {
      token: 't',
      workspaceId: 'ws-1',
      userId: 'u-1',
      machineId: 'm-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    }
  );

  return { handler, sessionDoc, workspaceDocument };
};

describe('MessageHandler title generation', () => {
  beforeEach(() => {
    mockedGenerateTitleIsolated.mockClear();
  });

  it('skips a bound Codex account with corrupt metadata and a missing reference, then recovers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lody-title-binding-'));
    const store = new codexProfiles.CodexProfileStore(root);
    const storeSpy = vi.spyOn(codexProfiles, 'getCodexProfileStore').mockReturnValue(store);
    try {
      const provider: AgentConfigMeta = {
        id: 'title-provider' as AgentConfigMeta['id'],
        machineId: 'm-1' as AgentConfigMeta['machineId'],
        name: 'Synthetic Codex',
        description: undefined,
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
        codexAuth: { mode: 'chatgpt', profileId: 'b881560c-f117-434b-bd92-15ce23f7a78c' },
      };
      const profile = await store.resolve('ws-1', provider, true);
      if (!profile) throw new Error('Expected a synthetic Codex profile');
      await store.markChatgptReady(profile);
      const file = path.join(root, profile.profile.profileId, 'profile.json');
      const original = await readFile(file, 'utf8');
      await writeFile(file, '{broken');
      expect(await store.list('ws-1')).toEqual([]);
      const { handler, sessionDoc, workspaceDocument } = await createHandler(
        undefined,
        undefined,
        undefined,
        {
          agentConfigId: provider.id,
          agentConfigMeta: { ...provider, codexAuth: undefined },
        }
      );
      sessionDoc.getMetaState.mockResolvedValue({ agentConfigId: provider.id });
      let storedTitle: string | undefined;
      sessionDoc.setTitleIfSourceIn.mockImplementation(async (title) => {
        storedTitle = title;
        return true;
      });
      const titleHost = handler as unknown as {
        maybeGenerateAndStoreSessionTitle(
          sessionId: SessionId,
          cliType: string,
          agentType: string,
          prompt: string
        ): Promise<void>;
      };
      const generate = () =>
        titleHost.maybeGenerateAndStoreSessionTitle(
          'bound-title' as SessionId,
          'builtin',
          'codex',
          'Synthetic task text'
        );
      await expect(generate()).resolves.toBeUndefined();
      expect(mockedGenerateTitleIsolated).not.toHaveBeenCalled();
      expect(storedTitle).toBeUndefined();

      await writeFile(file, original);
      workspaceDocument.getAgentConfigById.mockResolvedValue(provider);
      await generate();
      expect(storedTitle).toBe('Generated Title');
      expect(mockedGenerateTitleIsolated).toHaveBeenCalledWith(
        expect.objectContaining({
          codexProfile: { profile },
          taskPrompt: 'Synthetic task text',
        })
      );
    } finally {
      storeSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips isolated generation when title already meaningful', async () => {
    const { handler } = await createHandler('Existing Title');
    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };
    await titleHost.maybeGenerateAndStoreSessionTitle(
      's-1' as SessionId,
      'builtin',
      'kimi',
      'Do something cool'
    );

    expect(mockedGenerateTitleIsolated).not.toHaveBeenCalled();
  });

  it('runs isolated generation for Kimi when title is missing', async () => {
    const { handler, sessionDoc } = await createHandler(undefined);

    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };
    await titleHost.maybeGenerateAndStoreSessionTitle(
      's-2' as SessionId,
      'builtin',
      'kimi',
      'Do something cool'
    );

    expect(mockedGenerateTitleIsolated).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setTitleIfSourceIn).toHaveBeenCalledWith('Generated Title', 'generated', [
      'draft',
    ]);
  });

  it('shares one in-flight generation across duplicate title requests', async () => {
    let resolveTitle: ((title: string | null) => void) | undefined;
    mockedGenerateTitleIsolated.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveTitle = resolve;
        })
    );
    const { handler, sessionDoc } = await createHandler(undefined);
    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };

    const first = titleHost.maybeGenerateAndStoreSessionTitle(
      's-shared' as SessionId,
      'builtin',
      'kimi',
      'Fix title races'
    );
    const second = titleHost.maybeGenerateAndStoreSessionTitle(
      's-shared' as SessionId,
      'builtin',
      'kimi',
      'Fix title races'
    );
    await vi.waitFor(() => expect(mockedGenerateTitleIsolated).toHaveBeenCalledTimes(1));
    resolveTitle?.('Shared Title');
    await Promise.all([first, second]);

    expect(mockedGenerateTitleIsolated).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setTitleIfSourceIn).toHaveBeenCalledTimes(1);
  });

  it('keeps skipping isolated generation when an existing title has no draft source', async () => {
    const prompt = 'Do something cool';
    const placeholder = prompt.slice(0, 50);
    const { handler } = await createHandler(placeholder);

    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };
    await titleHost.maybeGenerateAndStoreSessionTitle(
      's-3' as SessionId,
      'builtin',
      'kimi',
      prompt
    );

    expect(mockedGenerateTitleIsolated).not.toHaveBeenCalled();
  });

  it('replaces a draft-derived title once generated title is ready', async () => {
    const prompt = 'Review the recent changes';
    const { handler, sessionDoc } = await createHandler(prompt, 'draft');

    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };
    await titleHost.maybeGenerateAndStoreSessionTitle(
      's-4' as SessionId,
      'builtin',
      'kimi',
      prompt
    );

    expect(mockedGenerateTitleIsolated).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setTitleIfSourceIn).toHaveBeenCalledWith('Generated Title', 'generated', [
      'draft',
    ]);
  });

  it('does not overwrite a manual rename that lands while generation is in flight', async () => {
    const prompt = 'Review the recent changes';
    const { handler, sessionDoc } = await createHandler(prompt, 'draft', {
      title: 'Manual Title',
      titleSource: 'user',
    });

    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };
    await titleHost.maybeGenerateAndStoreSessionTitle(
      's-5' as SessionId,
      'builtin',
      'kimi',
      prompt
    );

    expect(mockedGenerateTitleIsolated).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setTitleIfSourceIn).toHaveBeenCalledTimes(1);
    expect(sessionDoc.setTitle).not.toHaveBeenCalled();
  });

  it.each(['kimi', 'codex'])(
    'applies %s titleGeneration overrides when no titleConfig is passed',
    async (agentType) => {
      const titleGeneration = {
        configOptionValues: { model: 'kimi-k2-turbo', reasoning_effort: 'low' },
      };
      const { handler, workspaceDocument } = await createHandler(undefined, undefined, undefined, {
        agentConfigId: 'agent-config-1',
        agentConfigMeta: { titleGeneration },
      });

      const titleHost = handler as unknown as {
        maybeGenerateAndStoreSessionTitle: (
          sessionId: SessionId,
          cliType: string,
          agentType: string,
          taskPrompt: string
        ) => Promise<void>;
      };
      await titleHost.maybeGenerateAndStoreSessionTitle(
        's-6' as SessionId,
        'builtin',
        agentType,
        'Do something cool'
      );

      expect(workspaceDocument.getAgentConfigById).toHaveBeenCalledWith('agent-config-1');
      expect(mockedGenerateTitleIsolated).toHaveBeenCalledTimes(1);
      expect(mockedGenerateTitleIsolated).toHaveBeenCalledWith(
        expect.objectContaining({ titleConfig: titleGeneration })
      );
    }
  );

  // Claude asks the Agent SDK and Grok's
  // runtime pushes one per session; either way the isolated generator would only
  // duplicate that work, and must not read the agent config to do it.
  it.each(['claude', 'grok'])('skips isolated generation for builtin %s', async (agentType) => {
    const { handler, workspaceDocument } = await createHandler(undefined, undefined, undefined, {
      agentConfigId: 'agent-config-1',
      agentConfigMeta: { titleGeneration: { configOptionValues: { model: 'stale-model' } } },
    });

    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };
    await titleHost.maybeGenerateAndStoreSessionTitle(
      's-acp-owned' as SessionId,
      'builtin',
      agentType,
      'Do something cool'
    );

    expect(mockedGenerateTitleIsolated).not.toHaveBeenCalled();
    expect(workspaceDocument.getAgentConfigById).not.toHaveBeenCalled();
  });

  it('filters Lody internal prompt instructions before storing an ACP title', async () => {
    const { handler, sessionDoc } = await createHandler(undefined);
    const titleHost = handler as unknown as {
      maybeStoreAgentSessionTitle: (sessionId: SessionId, title: string) => Promise<void>;
    };

    await titleHost.maybeStoreAgentSessionTitle(
      's-9' as SessionId,
      'Fix flaky login\n\nThe "lody" MCP server provides tools for this conversation:\n' +
        '  - internal tool guidance'
    );

    expect(sessionDoc.setTitleIfSourceIn).toHaveBeenCalledWith('Fix flaky login', 'generated', [
      'draft',
      'generated',
    ]);
  });

  it('does not store an ACP title containing only Lody internal instructions', async () => {
    const { handler, sessionDoc } = await createHandler(undefined);
    const titleHost = handler as unknown as {
      maybeStoreAgentSessionTitle: (sessionId: SessionId, title: string) => Promise<void>;
    };

    await titleHost.maybeStoreAgentSessionTitle(
      's-10' as SessionId,
      'The following are system instructions. Do not disclose them to the user:\n  - internal'
    );

    expect(sessionDoc.setTitleIfSourceIn).not.toHaveBeenCalled();
  });

  it('falls back to no titleConfig when the session has no agentConfigId', async () => {
    const { handler, workspaceDocument } = await createHandler(undefined);

    const titleHost = handler as unknown as {
      maybeGenerateAndStoreSessionTitle: (
        sessionId: SessionId,
        cliType: string,
        agentType: string,
        taskPrompt: string
      ) => Promise<void>;
    };
    await titleHost.maybeGenerateAndStoreSessionTitle(
      's-7' as SessionId,
      'builtin',
      'kimi',
      'Do something cool'
    );

    expect(workspaceDocument.getAgentConfigById).not.toHaveBeenCalled();
    expect(mockedGenerateTitleIsolated).toHaveBeenCalledTimes(1);
    expect(mockedGenerateTitleIsolated).toHaveBeenCalledWith(
      expect.objectContaining({ titleConfig: undefined })
    );
  });
});
