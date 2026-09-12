import { withHistoryPort } from './history-port-fixture';
import { describe, expect, it, vi } from 'vitest';
import { type MessageContent, type SessionHistoryInput, type SessionId } from '@lody/shared';
import type { SessionDocument } from '../src/lib/loro/doc';
import { createWorktreeScriptHistoryRecorder } from '../src/session/worktree/worktree-script-history';
import type { Logger } from '../src/utils/logger';

const testLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  debug: vi.fn(),
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
    const sessionDoc = withHistoryPort({
      updateHistory,
      waitUntilSynced,
    }) as unknown as SessionDocument;

    const recorder = createWorktreeScriptHistoryRecorder({
      sessionDoc,
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
    const sessionDoc = withHistoryPort({
      updateHistory,
      waitUntilSynced,
    }) as unknown as SessionDocument;

    const recorder = createWorktreeScriptHistoryRecorder({
      sessionDoc,
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
});
