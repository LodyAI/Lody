import type { ModelInfo, SessionId, SessionInputBlock, WorkspaceId } from '@lody/shared';
import type { ContentBlock } from '@agentclientprotocol/sdk';

import {
  captureGitWorkingTreeDiffBaseline,
  getCurrentCommitHash,
  type GitRunner,
  type GitWorkingTreeDiffBaseline,
} from '@/lib/git/git-diff-stats';
import type { SessionDocument } from '@/lib/loro/doc';
import type { ISession } from '@/session/session-manager';

export type AutoPromptContext = {
  sessionId: SessionId;
  session: ISession;
  sessionDoc: SessionDocument;
  promptText: string;
  abortSignal?: AbortSignal;
  onPromptStart?: () => void | Promise<void>;
  onPromptEnd?: () => void | Promise<void>;
};

export type AutoPromptResult = {
  turnId: string;
  baseCommitHash: string | null;
  turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
};

export type AutoPromptRunnerDeps = {
  workspaceId: WorkspaceId;
  beginConversationTurn: (sessionId: SessionId, userTurnId?: string) => string;
  clearActiveTurnId: (sessionId: SessionId, turnId: string) => void;
  buildAcpPromptBlocks: (args: {
    workspaceId: WorkspaceId;
    sessionId: SessionId;
    inputBlocks: SessionInputBlock[];
  }) => Promise<ContentBlock[]>;
  createAssistantEntryForTurn: (
    sessionId: SessionId,
    sessionDoc: SessionDocument,
    turnId: string,
    modelInfo: ModelInfo | undefined
  ) => Promise<void>;
  finalizeACPState: (sessionId: SessionId, turnId: string) => Promise<void>;
  flushSessionUsage: (sessionId: SessionId) => Promise<void>;
};

export class AutoPromptRunner {
  constructor(private readonly deps: AutoPromptRunnerDeps) {}

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new Error('Auto prompt aborted');
    }
  }

  async run(ctx: AutoPromptContext): Promise<AutoPromptResult> {
    const { sessionId, session, sessionDoc, promptText, abortSignal } = ctx;
    if (!session.agentClient || !session.acpSessionId) {
      throw new Error('Agent session not ready for auto prompt');
    }

    this.throwIfAborted(abortSignal);
    const turnId = this.deps.beginConversationTurn(sessionId);
    const workdir = session.getWorkdir();
    const runGit: GitRunner = (args) => session.exec('git', args, workdir, false);
    const baseCommitHash = await getCurrentCommitHash(runGit);
    const turnStartWorkingTreeDiff = await captureGitWorkingTreeDiffBaseline(runGit);

    try {
      this.throwIfAborted(abortSignal);
      await this.deps.createAssistantEntryForTurn(
        sessionId,
        sessionDoc,
        turnId,
        session.agentClient.currentModel
      );

      const promptBlocks = await this.deps.buildAcpPromptBlocks({
        workspaceId: this.deps.workspaceId,
        sessionId,
        inputBlocks: [{ type: 'text', text: promptText }],
      });

      this.throwIfAborted(abortSignal);
      await ctx.onPromptStart?.();
      try {
        if (abortSignal) {
          await session.agentClient.prompt(session.acpSessionId, promptBlocks, {
            signal: abortSignal,
          });
        } else {
          await session.agentClient.prompt(session.acpSessionId, promptBlocks);
        }
      } finally {
        await ctx.onPromptEnd?.();
      }
    } finally {
      this.deps.clearActiveTurnId(sessionId, turnId);
      await this.deps.finalizeACPState(sessionId, turnId);
      await this.deps.flushSessionUsage(sessionId);
    }

    return { turnId, baseCommitHash, turnStartWorkingTreeDiff };
  }
}
