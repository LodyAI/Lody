import { describe, expect, it, vi } from 'vitest';
import type { ACPSessionId, SessionId, WorkspaceId } from '@lody/shared';

import type { SessionDocument } from '../src/lib/loro/doc';
import { AutoPromptRunner } from '../src/session/auto-prompt-runner';
import type { ISession } from '../src/session/session-manager';

describe('AutoPromptRunner', () => {
  it('always finalizes ACP state after an automated prompt attempt', async () => {
    const prompt = vi.fn(async () => {
      throw new Error('prompt failed');
    });
    const session = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient: {
        currentModel: undefined,
        prompt,
      },
      getWorkdir: () => '/tmp/workdir',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'rev-parse HEAD') return 'abc123\n';
        throw new Error(`unexpected git args: ${key}`);
      }),
    } as unknown as ISession;
    const sessionDoc = {};
    const clearActiveTurnId = vi.fn();
    const finalizeACPState = vi.fn(async () => {});
    const flushSessionUsage = vi.fn(async () => {});
    const runner = new AutoPromptRunner({
      workspaceId: 'workspace-1' as WorkspaceId,
      beginConversationTurn: vi.fn(() => 'auto-turn-1'),
      clearActiveTurnId,
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'commit' }]),
      createAssistantEntryForTurn: vi.fn(async () => {}),
      finalizeACPState,
      flushSessionUsage,
    });

    await expect(
      runner.run({
        sessionId: 'session-1' as SessionId,
        session,
        sessionDoc: sessionDoc as unknown as SessionDocument,
        promptText: 'commit',
      })
    ).rejects.toThrow('prompt failed');

    expect(prompt).toHaveBeenCalledWith('acp-1', [{ type: 'text', text: 'commit' }]);
    expect(clearActiveTurnId).toHaveBeenCalledWith('session-1', 'auto-turn-1');
    // Named turn, not a bare session: a no-turnId finalize closes whichever
    // assistant entry is last and clears turn state unconditionally.
    expect(finalizeACPState).toHaveBeenCalledWith('session-1', 'auto-turn-1');
    expect(flushSessionUsage).toHaveBeenCalledWith('session-1');
  });

  it('passes abort signal through the automated prompt scope', async () => {
    const controller = new AbortController();
    const prompt = vi.fn(async () => ({}));
    const session = {
      sessionId: 'session-1' as SessionId,
      acpSessionId: 'acp-1' as ACPSessionId,
      agentClient: {
        currentModel: undefined,
        prompt,
      },
      getWorkdir: () => '/tmp/workdir',
      exec: vi.fn(async (_command: string, args: string[]) => {
        const key = args.join(' ');
        if (key === 'rev-parse --is-inside-work-tree') return 'true\n';
        if (key === 'rev-parse HEAD') return 'abc123\n';
        throw new Error(`unexpected git args: ${key}`);
      }),
    } as unknown as ISession;
    const onPromptStart = vi.fn();
    const onPromptEnd = vi.fn();
    const runner = new AutoPromptRunner({
      workspaceId: 'workspace-1' as WorkspaceId,
      beginConversationTurn: vi.fn(() => 'auto-turn-1'),
      clearActiveTurnId: vi.fn(),
      buildAcpPromptBlocks: vi.fn(async () => [{ type: 'text', text: 'commit' }]),
      createAssistantEntryForTurn: vi.fn(async () => {}),
      finalizeACPState: vi.fn(async () => {}),
      flushSessionUsage: vi.fn(async () => {}),
    });

    await runner.run({
      sessionId: 'session-1' as SessionId,
      session,
      sessionDoc: {} as unknown as SessionDocument,
      promptText: 'commit',
      abortSignal: controller.signal,
      onPromptStart,
      onPromptEnd,
    });

    expect(prompt).toHaveBeenCalledWith('acp-1', [{ type: 'text', text: 'commit' }], {
      signal: controller.signal,
    });
    expect(onPromptStart).toHaveBeenCalledTimes(1);
    expect(onPromptEnd).toHaveBeenCalledTimes(1);
  });
});
