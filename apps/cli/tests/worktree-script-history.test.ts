import { withHistoryPort } from './history-port-fixture';
import { describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { v4 as uuidv4 } from 'uuid';
import { SessionDocument } from '../src/lib/loro/doc';
import { type MessageContent, type SessionHistoryInput, type SessionId } from '@lody/shared';
import { createWorktreeScriptHistoryRecorder } from '../src/session/worktree/worktree-script-history';
import type { Logger } from '../src/utils/logger';

const testLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  setLevel: vi.fn(),
  setDebug: vi.fn(),
  child: vi.fn(() => testLogger),
  close: vi.fn(async () => {}),
};

describe('worktree script history recorder', () => {
  it('streams per-step output into one system worktree script history item', async () => {
    let history: SessionHistoryInput[] = [];
    const updateHistory = vi.fn(
      async (updateFn: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = updateFn(history);
      }
    );
    const waitUntilSynced = vi.fn(async () => true);
    const fixture = withHistoryPort({
      updateHistory,
      waitUntilSynced,
    });
    const sessionDoc = fixture as unknown as SessionDocument;

    const recorder = createWorktreeScriptHistoryRecorder({
      sessionDoc,
      backend: fixture,
      sessionId: 'session-1' as SessionId,
      phase: 'setup',
      logger: testLogger,
    });

    await recorder.onStart?.({
      phase: 'setup',
      shell: 'bash',
      displayCommand: 'echo secret-token\necho hello',
      command: 'bash',
      args: ['-l'],
      workdir: '/tmp/worktree',
    });
    await recorder.onStepStart?.({
      phase: 'setup',
      shell: 'bash',
      stepIndex: 0,
      displayCommand: 'echo secret-token',
      workdir: '/tmp/worktree',
    });
    await recorder.onOutput?.({
      phase: 'setup',
      stepIndex: 0,
      stream: 'stdout',
      chunk: 'secret-token\n',
    });
    await recorder.onStepEnd?.({
      phase: 'setup',
      stepIndex: 0,
      status: 'completed',
      exitStatus: { exitCode: 0, signal: null },
    });
    await recorder.onStepStart?.({
      phase: 'setup',
      shell: 'bash',
      stepIndex: 1,
      displayCommand: 'echo hello',
      workdir: '/tmp/worktree',
    });
    await recorder.onOutput?.({
      phase: 'setup',
      stepIndex: 1,
      stream: 'stdout',
      chunk: 'hello\n',
    });
    await recorder.onStepEnd?.({
      phase: 'setup',
      stepIndex: 1,
      status: 'completed',
      exitStatus: { exitCode: 0, signal: null },
    });
    await recorder.onEnd?.({
      phase: 'setup',
      status: 'completed',
      exitStatus: { exitCode: 0, signal: null },
    });

    expect(history).toHaveLength(1);
    const entry = history[0];
    expect(entry?.role).toBe('system');
    expect(entry?.finished).toBe(true);
    expect(entry?.modelInfo).toBeUndefined();
    expect(waitUntilSynced).toHaveBeenCalledTimes(1);

    const items = entry?.items as MessageContent[] | undefined;
    expect(items).toHaveLength(1);
    const item = items?.[0];
    expect(item?.type).toBe('worktree_script');
    if (item?.type !== 'worktree_script') {
      throw new Error('Expected worktree script history item.');
    }
    expect(item.phase).toBe('setup');
    expect(item.status).toBe('completed');
    expect(item.steps).toHaveLength(2);
    expect(item.steps[0]?.command).toBe('echo secret-token');
    expect(item.steps[0]?.output).toBe('secret-token\n');
    expect(item.steps[0]?.exitStatus?.exitCode).toBe(0);
    expect(item.steps[1]?.command).toBe('echo hello');
    expect(item.steps[1]?.output).toBe('hello\n');
    expect(item.steps[1]?.exitStatus?.exitCode).toBe(0);
  });

  it('inserts setup history before an existing assistant placeholder', async () => {
    let history: SessionHistoryInput[] = [
      {
        id: 'turn-1',
        role: 'assistant',
        items: [],
        timestamp: new Date().toISOString(),
        fileDiff: [],
      },
    ];
    const updateHistory = vi.fn(
      async (updateFn: (history: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = updateFn(history);
      }
    );
    const waitUntilSynced = vi.fn(async () => true);
    const fixture = withHistoryPort({
      updateHistory,
      waitUntilSynced,
    });
    const sessionDoc = fixture as unknown as SessionDocument;

    const recorder = createWorktreeScriptHistoryRecorder({
      sessionDoc,
      backend: fixture,
      sessionId: 'session-1' as SessionId,
      phase: 'setup',
      logger: testLogger,
      insertBeforeEntryId: 'turn-1',
    });

    await recorder.onStart?.({
      phase: 'setup',
      shell: 'bash',
      displayCommand: 'echo hello',
      command: 'bash',
      args: ['-l'],
      workdir: '/tmp/worktree',
    });
    await recorder.onStepStart?.({
      phase: 'setup',
      shell: 'bash',
      stepIndex: 0,
      displayCommand: 'echo hello',
      workdir: '/tmp/worktree',
    });
    await recorder.onOutput?.({
      phase: 'setup',
      stepIndex: 0,
      stream: 'stdout',
      chunk: 'hello\n',
    });
    await recorder.onEnd?.({
      phase: 'setup',
      status: 'completed',
      exitStatus: { exitCode: 0, signal: null },
    });

    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('system');
    expect(history[0]?.items[0]?.type).toBe('worktree_script');
    expect(history[1]?.id).toBe('turn-1');
    expect(history[1]?.role).toBe('assistant');
  });
  it('does not churn LoroText oplog across 250ms flushes once step output exceeds 128k', async () => {
    vi.useFakeTimers();
    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    try {
      const recorder = createWorktreeScriptHistoryRecorder({
        sessionDoc: doc,
        backend: doc.sessionData.commands,
        sessionId,
        phase: 'setup',
        logger: testLogger,
      });

      await recorder.onStart?.({
        phase: 'setup',
        shell: 'bash',
        displayCommand: 'yes',
        command: 'bash',
        args: ['-l'],
        workdir: '/tmp/worktree',
      });
      await recorder.onStepStart?.({
        phase: 'setup',
        shell: 'bash',
        stepIndex: 0,
        displayCommand: 'yes',
        workdir: '/tmp/worktree',
      });

      let fullOutput = '';
      for (let tick = 0; tick < 40; tick += 1) {
        const chunk = `[${String(tick).padStart(2, '0')}]${String.fromCharCode(65 + (tick % 26)).repeat(7995)}\n`;
        fullOutput += chunk;
        recorder.onOutput?.({
          phase: 'setup',
          stepIndex: 0,
          stream: 'stdout',
          chunk,
        });
        await vi.advanceTimersByTimeAsync(250);
      }

      await recorder.onStepEnd?.({
        phase: 'setup',
        stepIndex: 0,
        status: 'completed',
        exitStatus: { exitCode: 0, signal: null },
      });
      await recorder.onEnd?.({
        phase: 'setup',
        status: 'completed',
        exitStatus: { exitCode: 0, signal: null },
      });

      const history = await doc.sessionData.history.readAll();
      const scriptItem = history[0]?.items?.[0];
      expect(scriptItem?.type).toBe('worktree_script');
      if (scriptItem?.type !== 'worktree_script') {
        throw new Error('Expected worktree_script item');
      }
      expect(scriptItem.steps[0]?.truncated).toBe(true);
      expect(scriptItem.steps[0]?.output).toBe(fullOutput.slice(-128_000));
      // Without freezing once truncated, 24 overlapping 128k sliding rewrites would bloat the LoroDoc to multi-MB.
      expect(doc.handle?.doc.export({ mode: 'snapshot' }).length).toBeLessThan(350 * 1024);
    } finally {
      vi.useRealTimers();
      await repo.destroy();
    }
  });
});
