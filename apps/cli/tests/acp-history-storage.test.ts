import { updateTestHistory } from './history-port-fixture';
import { describe, expect, it } from 'vitest';

import { LoroRepo } from 'loro-repo';
import { v4 as uuidv4 } from 'uuid';

import type { MessageContent, SessionHistoryInput, SessionId } from '@lody/shared';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { SessionDocument } from '../src/lib/loro/doc';
import { appendAutonomousACPNotifications } from '../src/lib/acp/history';
import type { Logger } from '../src/utils/logger';
import terminalUpdates from './fixtures/acp/terminal-notifications.json';
import e2eUpdates from './fixtures/acp/e2e-notifications.json';
import kimiShellUpdates from './fixtures/acp/kimi-shell-notifications.sample.json';

const parseContents = (entry: SessionHistoryInput): MessageContent[] => {
  const rawItems = entry.items;
  return Array.isArray(rawItems) ? (rawItems as unknown as MessageContent[]) : [];
};

const findToolCall = (
  history: SessionHistoryInput[],
  toolCallId: string
): Extract<MessageContent, { type: 'tool_call' }> | null => {
  for (const entry of history) {
    for (const item of parseContents(entry)) {
      if (item.type === 'tool_call' && item.toolCallId === toolCallId) {
        return item;
      }
    }
  }
  return null;
};

const createTestLogger = (warnings: string[]): Logger => ({
  info: () => {},
  warn: (message) => {
    warnings.push(String(message));
  },
  error: () => {},
  success: () => {},
  debug: (message) => {
    warnings.push(String(message));
  },
  setLevel: () => {},
  child: () => createTestLogger(warnings),
  close: async () => {},
});

describe('session history storage (integration)', () => {
  it('allows undefined optional history fields without pre-stripping', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    const initialToolCall = {
      type: 'tool_call',
      toolCallId: 'call_with_undefined',
      title: 'Echo ok',
      kind: 'execute',
      status: 'pending',
      content: [
        {
          type: 'terminal_command',
          command: 'echo ok',
          args: ['ok'],
          cwd: '/tmp',
        },
      ],
      locations: [{ path: '/tmp/file.txt' }],
    } as unknown as MessageContent;

    await updateTestHistory(doc, (history) => [
      ...history,
      {
        id: 'assistant-1',
        role: 'assistant',
        items: [initialToolCall] as unknown as SessionHistoryInput['items'],
        timestamp: new Date().toISOString(),
        fileDiff: [],
      },
    ]);
    await updateTestHistory(doc, (history) => {
      const existing = findToolCall(history, 'call_with_undefined');
      if (existing) {
        existing.title = undefined;
        existing.kind = undefined;
        existing.locations = undefined;
        const command = existing.content?.[0];
        if (command?.type === 'terminal_command') {
          command.args = undefined;
          command.cwd = undefined;
        }
      }
      return history;
    });

    const history = await doc.sessionData.history.readAll();
    const toolCall = findToolCall(history, 'call_with_undefined');
    expect(toolCall).not.toBeNull();
    expect(toolCall?.locations).toBeUndefined();
    expect(toolCall?.title).toBeUndefined();

    expect(toolCall?.content).toHaveLength(1);
    const command = toolCall?.content?.[0];
    expect(command?.type).toBe('terminal_command');
    expect(command?.type === 'terminal_command' ? command.args : null).toBeUndefined();
    expect(command?.type === 'terminal_command' ? command.cwd : null).toBeUndefined();
  });

  it('should contain only one of the terminal output and record them by delta', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();
    await appendAutonomousACPNotifications(doc, terminalUpdates as SessionNotification[]);
    const history = await doc.sessionData.history.readAll();
    expect(history).toMatchObject([
      {
        id: expect.any(String),
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'call_47hqFYHbdWfeKgUeoNGnhleM',
            title:
              'Run for i in $(seq 1 200); do echo "line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; sleep 0.02; done',
            kind: 'execute',
            status: 'in_progress',
            content: [
              {
                type: 'terminal_command',
                command: '/bin/zsh',
                args: [
                  '-lc',
                  'for i in $(seq 1 200); do echo "line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; sleep 0.02; done',
                ],
                cwd: '/var/folders/x9/v95xfgsd7q77l65gphtc4vdw0000gn/T/lody-acp-history-e2e-compact',
              },
            ],
          },
        ],
        timestamp: expect.any(String),
      },
    ]);
    expect(doc.handle?.doc.export({ mode: 'snapshot' }).length).toBeLessThan(2500);
  });

  it('should record notifications', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();
    for (const u of e2eUpdates as SessionNotification[]) {
      await appendAutonomousACPNotifications(doc, u);
    }
    const history = await doc.sessionData.history.readAll();
    console.log(JSON.stringify(history, null, 2));
    console.log(JSON.stringify(history).length);
    expect(doc.handle?.doc.export({ mode: 'snapshot' }).length).toBeLessThan(6500);
  });

  it('does not persist file contents for read/edit but still triggers editCallback', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    try {
      const oldSentinel = 'E2E_SENTINEL_OLD_29d01d79';
      const newSentinel = 'E2E_SENTINEL_NEW_2d5d9a7a';
      const oldText = `${oldSentinel}\nalpha\nbeta\n`;
      const newText = `${newSentinel}\nalpha\nbeta\ngamma\n`;

      const execId = 'call_exec_1';
      const readId = 'call_read_1';
      const editId = 'call_edit_1';

      const makeNotification = (update: SessionNotification['update']): SessionNotification => ({
        sessionId,
        update,
      });

      const execSnapshots = [
        'tick:1',
        ['tick:1', 'tick:2'].join('\n'),
        ['tick:1', 'tick:2', 'tick:3'].join('\n'),
      ];
      const execFinalSnapshot = execSnapshots.at(-1);
      if (!execFinalSnapshot) {
        throw new Error('Expected execSnapshots to be non-empty');
      }

      // Stream execute output using snapshot-style fenced blocks (like Codex).
      await appendAutonomousACPNotifications(doc, [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: execId,
          title: 'Run streaming command',
          status: 'in_progress',
          kind: 'execute',
          rawInput: {
            command: ['/bin/bash', '-lc', 'for i in 1 2 3; do echo tick:$i; done'],
            cwd: '/tmp',
          },
        }),
      ]);

      for (const snapshot of execSnapshots) {
        await appendAutonomousACPNotifications(doc, [
          makeNotification({
            sessionUpdate: 'tool_call_update',
            toolCallId: execId,
            status: 'in_progress',
            kind: 'execute',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: `\`\`\`sh\n${snapshot}\n\`\`\`\n` },
              },
            ],
          }),
        ]);
      }

      // Intermediate streaming output should not be persisted into the Loro history.
      let history = await doc.sessionData.history.readAll();
      const execToolBeforeComplete = findToolCall(history, execId);
      if (!execToolBeforeComplete) {
        throw new Error(`Expected tool_call ${execId} to exist`);
      }
      expect((execToolBeforeComplete.content ?? []).some((b) => b.type === 'terminal_output')).toBe(
        false
      );

      await appendAutonomousACPNotifications(doc, [
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: execId,
          status: 'completed',
          kind: 'execute',
          rawOutput: {
            exit_code: 0,
            aggregated_output: `${execFinalSnapshot}\n`,
            stdout: `${execFinalSnapshot}\n`,
            stderr: '',
          },
        }),
      ]);

      history = await doc.sessionData.history.readAll();
      const execTool = findToolCall(history, execId);
      if (!execTool) {
        throw new Error(`Expected tool_call ${execId} to exist`);
      }
      expect(execTool.kind).toBe('execute');

      const execBlocks = execTool.content ?? [];
      expect(execBlocks.some((b) => b.type === 'content')).toBe(false);

      const execTerminalOutputs = execBlocks.filter((b) => b.type === 'terminal_output') as Array<{
        type: 'terminal_output';
        output: string;
      }>;
      expect(execTerminalOutputs).toHaveLength(1);
      const execTerminalOutput = execTerminalOutputs[0];
      if (!execTerminalOutput) {
        throw new Error(`Expected a terminal_output block for ${execId}`);
      }
      expect(execTerminalOutput.output).toBe(`${execFinalSnapshot}\n`);

      // Read should not persist file contents.
      await appendAutonomousACPNotifications(doc, [
        makeNotification({
          sessionUpdate: 'tool_call',
          toolCallId: readId,
          title: 'Read file',
          status: 'in_progress',
          kind: 'read',
          rawInput: {
            command: ['/bin/bash', '-lc', "sed -n '1,20p' acp-history-storage.txt"],
            cwd: '/tmp',
          },
          locations: [{ path: '/tmp/acp-history-storage.txt' }],
        }),
        makeNotification({
          sessionUpdate: 'tool_call_update',
          toolCallId: readId,
          status: 'completed',
          kind: 'read',
          rawOutput: {
            exit_code: 0,
            aggregated_output: oldText,
            stdout: oldText,
            stderr: '',
          },
          content: [
            { type: 'content', content: { type: 'text', text: oldText } },
            { type: 'content', content: { type: 'text', text: oldText } },
          ],
        }),
      ]);

      history = await doc.sessionData.history.readAll();
      const readTool = findToolCall(history, readId);
      if (!readTool) {
        throw new Error(`Expected tool_call ${readId} to exist`);
      }
      expect(readTool.kind).toBe('read');
      expect(readTool.locations?.[0]?.path).toBe('/tmp/acp-history-storage.txt');

      const readTypes = new Set((readTool.content ?? []).map((b) => b.type));
      expect(readTypes.has('terminal_output')).toBe(false);
      expect(readTypes.has('content')).toBe(false);
      expect(readTypes.has('diff')).toBe(false);

      // Edit should not persist diffs, but should still trigger the callback.
      const editsSeen: Array<{ path: string; oldText: string | null; newText: string }> = [];
      await appendAutonomousACPNotifications(
        doc,
        [
          makeNotification({
            sessionUpdate: 'tool_call',
            toolCallId: editId,
            title: 'Edit file',
            status: 'in_progress',
            kind: 'edit',
          }),
          makeNotification({
            sessionUpdate: 'tool_call_update',
            toolCallId: editId,
            status: 'completed',
            kind: 'edit',
            content: [
              {
                type: 'diff',
                path: '/tmp/acp-history-storage.txt',
                oldText,
                newText,
              },
              {
                type: 'content',
                content: { type: 'text', text: 'Success. Updated the following files:\nM ...\n' },
              },
            ],
          }),
        ],
        {
          editCallback: (edits) => {
            editsSeen.push(...edits);
          },
        },
        undefined
      );

      // Hunk-level old/new text is not forwarded as file content; the edit still reports the
      // path as an update so per-turn membership survives.
      expect(editsSeen).toEqual([
        {
          path: '/tmp/acp-history-storage.txt',
          changeType: 'update',
          contentOldText: oldText,
          contentNewText: newText,
        },
      ]);

      const newFileEditsSeen: Array<unknown> = [];
      await appendAutonomousACPNotifications(
        doc,
        [
          makeNotification({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'edit-new-file',
            status: 'completed',
            kind: 'edit',
            content: [
              {
                type: 'diff',
                path: '/tmp/new-file.txt',
                oldText: null,
                newText: 'created\n',
              },
            ],
          }),
        ],
        {
          editCallback: (edits) => {
            newFileEditsSeen.push(...edits);
          },
        },
        undefined
      );

      // A created-file diff block (oldText: null) proves the full new text.
      expect(newFileEditsSeen).toEqual([
        { path: '/tmp/new-file.txt', changeType: 'add', fullNewText: 'created\n' },
      ]);

      history = await doc.sessionData.history.readAll();
      const editTool = findToolCall(history, editId);
      if (!editTool) {
        throw new Error(`Expected tool_call ${editId} to exist`);
      }
      expect(editTool.kind).toBe('edit');
      // Even when diffs are stripped, we should keep the edited path for follow-along.
      expect(editTool.locations?.[0]?.path).toBe('/tmp/acp-history-storage.txt');

      const editTypes = new Set((editTool.content ?? []).map((b) => b.type));
      expect(editTypes.has('diff')).toBe(false);
      expect(editTypes.has('content')).toBe(false);

      // Ensure sentinels are not persisted anywhere in history payloads.
      const historyJson = JSON.stringify(history);
      expect(historyJson.includes(oldSentinel)).toBe(false);
      expect(historyJson.includes(newSentinel)).toBe(false);
    } finally {
      await repo.destroy();
    }
  });

  it('extracts terminal_command and terminal_output from Kimi shell notifications', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();
    await appendAutonomousACPNotifications(doc, kimiShellUpdates as SessionNotification[]);
    const history = await doc.sessionData.history.readAll();

    // First tool call: successful shell command
    const tool1 = findToolCall(history, 'kimi-session-sample/tool_shell_1');
    expect(tool1).not.toBeNull();
    expect(tool1!.title).toBe('Shell: echo hello');
    expect(tool1!.status).toBe('completed');

    const tool1Blocks = tool1!.content ?? [];
    const tool1Types = tool1Blocks.map((b) => b.type);
    expect(tool1Types).toContain('terminal_command');
    expect(tool1Types).toContain('terminal_output');

    const cmdBlock = tool1Blocks.find((b) => b.type === 'terminal_command');
    expect(cmdBlock).toBeDefined();
    if (cmdBlock?.type === 'terminal_command') {
      expect(cmdBlock.command).toBe('echo hello world');
    }

    const outBlock = tool1Blocks.find((b) => b.type === 'terminal_output');
    expect(outBlock).toBeDefined();
    if (outBlock?.type === 'terminal_output') {
      expect(outBlock.output).toContain('hello world');
    }

    // The plain text content block that duplicates the terminal output should be deduped.
    const contentBlocks = tool1Blocks.filter(
      (b) =>
        b.type === 'content' &&
        'content' in b &&
        b.content.type === 'text' &&
        b.content.text.trim().length > 0
    );
    expect(contentBlocks).toHaveLength(0);

    // Second tool call: failed shell command
    const tool2 = findToolCall(history, 'kimi-session-sample/tool_shell_2');
    expect(tool2).not.toBeNull();
    expect(tool2!.title).toBe('Shell: ls -la');
    expect(tool2!.status).toBe('failed');

    const tool2Blocks = tool2!.content ?? [];
    const tool2Types = tool2Blocks.map((b) => b.type);
    expect(tool2Types).toContain('terminal_command');
    expect(tool2Types).toContain('terminal_output');

    const cmd2Block = tool2Blocks.find((b) => b.type === 'terminal_command');
    if (cmd2Block?.type === 'terminal_command') {
      expect(cmd2Block.command).toBe('ls -la /tmp');
    }

    const out2Block = tool2Blocks.find((b) => b.type === 'terminal_output');
    if (out2Block?.type === 'terminal_output') {
      expect(out2Block.output).toContain('Permission denied');
    }

    // Agent message chunk should also be in history
    const textItems = history.flatMap((h) => parseContents(h).filter((c) => c.type === 'text'));
    expect(textItems.some((t) => t.type === 'text' && t.text.includes('successfully'))).toBe(true);

    // === ReadFile: kind="read", locations with path, file contents stripped ===
    const readTool = findToolCall(history, 'kimi-session-sample/tool_read_1');
    expect(readTool).not.toBeNull();
    expect(readTool!.title).toBe('ReadFile: test.txt');
    expect(readTool!.kind).toBe('read');
    expect(readTool!.status).toBe('completed');
    expect(readTool!.locations).toBeDefined();
    expect(readTool!.locations![0]!.path).toBe('test.txt');
    // File contents should be stripped for read tools (no content/terminal_output blocks)
    const readBlocks = readTool!.content ?? [];
    const readBlockTypes = readBlocks.map((b) => b.type);
    expect(readBlockTypes).not.toContain('terminal_output');
    // No content block with full file text should survive
    const readContentBlocks = readBlocks.filter(
      (b) =>
        b.type === 'content' &&
        'content' in b &&
        b.content.type === 'text' &&
        b.content.text.includes('Hello World')
    );
    expect(readContentBlocks).toHaveLength(0);

    // === StrReplaceFile: kind="edit", locations from diff, diff stripped ===
    const editTool = findToolCall(history, 'kimi-session-sample/tool_edit_1');
    expect(editTool).not.toBeNull();
    expect(editTool!.title).toBe('StrReplaceFile: test.txt');
    expect(editTool!.kind).toBe('edit');
    expect(editTool!.status).toBe('completed');
    expect(editTool!.locations).toBeDefined();
    expect(editTool!.locations![0]!.path).toBe('/project/test.txt');
    // Diff blocks should be stripped for edit tools
    const editBlocks = editTool!.content ?? [];
    const editBlockTypes = editBlocks.map((b) => b.type);
    expect(editBlockTypes).not.toContain('diff');
    expect(editBlockTypes).not.toContain('content');
  });

  it('logs diagnostics and drops invalid agent text chunks', async () => {
    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    const warnings: string[] = [];
    const logger = createTestLogger(warnings);

    const invalidNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: undefined },
      },
    } as unknown as SessionNotification;

    await appendAutonomousACPNotifications(doc, [invalidNotification], { logger }, undefined);

    const history = await doc.sessionData.history.readAll();
    expect(history.length).toBe(0);
    expect(warnings.length).toBe(1);
  });
});
