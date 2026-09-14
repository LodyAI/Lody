/**
 * E2E test for Claude Code ACP Notification Updates
 *
 * This test exercises the full Claude Code ACP flow including:
 * - Reading files
 * - Writing/editing files
 * - Executing terminal commands
 * - Creating plans (TodoWrite)
 *
 * It captures all notification updates during the session and exports them
 * to a JSON file for analysis.
 */
import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { LoroRepo } from 'loro-repo';

import type { Logger } from '../../src/utils/logger';
import type { MessageContent, SessionHistoryInput, SessionId } from '@lody/shared';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { startLocalAcpAgent } from '../../src/agent/acp-runner';
import { extractTextFromAgentResponse } from '../../src/agent/response-utils';
import { ShellTerminalManager, type TerminalManager } from '../../src/session/terminal-manager';
import { SessionDocument } from '../../src/lib/loro/doc';
import { appendAutonomousACPNotifications } from '../../src/lib/acp/history';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const runE2E = process.env.LODY_E2E === '1';
const e2eDescribe = runE2E ? describe : describe.skip;

const parseContents = (entry: SessionHistoryInput): MessageContent[] => {
  if (Array.isArray(entry.items)) {
    return entry.items as unknown as MessageContent[];
  }
  return [];
};

const createRecordingTerminalManager = (workdir: string, logger: Logger) => {
  let activeSessionId: string | null = null;
  const base = new ShellTerminalManager({
    logger,
    sessionLabel: 'claude-code-e2e',
    getActiveAcpSessionId: () => activeSessionId,
    resolveWorkdir: (cwd?: string) => cwd ?? workdir,
    buildEnv: (overrides?: Record<string, string>) => ({ ...process.env, ...overrides }),
  });

  const records = {
    create: [] as Array<{
      terminalId: string;
      command: string;
      args: string[];
      cwd?: string;
    }>,
    output: [] as Array<{
      terminalId: string;
      outputLen: number;
      truncated: boolean;
      exitStatus: unknown | null;
      outputPreview: string;
    }>,
    wait: [] as Array<{ terminalId: string; exitStatus: unknown }>,
    release: [] as Array<{ terminalId: string }>,
    kill: [] as Array<{ terminalId: string }>,
  };

  const manager: TerminalManager = {
    createTerminal: async (sessionId, command, args, cwd, env, outputByteLimit) => {
      const terminalId = await base.createTerminal(
        sessionId,
        command,
        args,
        cwd,
        env,
        outputByteLimit
      );
      records.create.push({
        terminalId,
        command,
        args: args ?? [],
        cwd,
      });
      return terminalId;
    },
    terminalOutput: async (sessionId, terminalId) => {
      const result = await base.terminalOutput(sessionId, terminalId);
      records.output.push({
        terminalId,
        outputLen: result.output.length,
        truncated: result.truncated,
        exitStatus: result.exitStatus,
        outputPreview: result.output.slice(-2000),
      });
      return result;
    },
    releaseTerminal: async (sessionId, terminalId) => {
      records.release.push({ terminalId });
      await base.releaseTerminal(sessionId, terminalId);
    },
    waitForTerminalExit: async (sessionId, terminalId) => {
      const status = await base.waitForTerminalExit(sessionId, terminalId);
      records.wait.push({ terminalId, exitStatus: status });
      return status;
    },
    killTerminal: async (sessionId, terminalId) => {
      records.kill.push({ terminalId });
      await base.killTerminal(sessionId, terminalId);
    },
  };

  return {
    manager,
    setActiveSessionId: (id: string) => {
      activeSessionId = id;
    },
    getRecords: () => records,
  };
};

const summarizeNotification = (n: SessionNotification) => {
  const update = n.update;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      if (update.content?.type === 'text') {
        return {
          sessionUpdate: update.sessionUpdate,
          text: update.content.text.slice(0, 200),
        };
      }
      return { sessionUpdate: update.sessionUpdate, contentType: update.content?.type };
    case 'tool_call': {
      const terminalCount = (update.content || []).filter((c) => c.type === 'terminal').length;
      return {
        sessionUpdate: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status,
        kind: update.kind,
        terminalChunks: terminalCount,
        rawInputKeys: update.rawInput ? Object.keys(update.rawInput) : undefined,
        rawOutputPreview: update.rawOutput
          ? JSON.stringify(update.rawOutput).slice(0, 200)
          : undefined,
        diffs: (update.content || [])
          .filter((c) => c.type === 'diff')
          .map((d) => ({
            path: d.path,
            oldTextLen: d.oldText?.length ?? 0,
            newTextLen: d.newText.length,
          })),
      };
    }
    case 'tool_call_update': {
      const terminalCount = (update.content || []).filter((c) => c.type === 'terminal').length;
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status,
        kind: update.kind,
        terminalChunks: terminalCount,
        rawInputKeys: update.rawInput ? Object.keys(update.rawInput) : undefined,
        rawOutputPreview: update.rawOutput
          ? JSON.stringify(update.rawOutput).slice(0, 200)
          : undefined,
        diffs: (update.content || [])
          .filter((c) => c.type === 'diff')
          .map((d) => ({
            path: d.path,
            oldTextLen: d.oldText?.length ?? 0,
            newTextLen: d.newText.length,
          })),
      };
    }
    case 'plan':
      return { sessionUpdate: 'plan', entries: update.entries };
    case 'available_commands_update':
      return {
        sessionUpdate: 'available_commands_update',
        count: update.availableCommands?.length ?? 0,
      };
    default:
      return { sessionUpdate: update.sessionUpdate };
  }
};

const summarizeHistory = (history: SessionHistoryInput[]) =>
  history.map((h) => ({
    id: h.id,
    role: h.role,
    timestamp: h.timestamp,
    contents: parseContents(h),
    // Plan is now a separate field on the history entry, not in contents
    plan: h.plan,
  }));

const sanitizeNotificationsForFixture = (notifications: SessionNotification[], workdir: string) =>
  notifications.map((n) => {
    const update = n.update as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...n,
      sessionId: 'session-captured',
      update: { ...update },
    };
    const nextUpdate = next.update as Record<string, unknown>;
    if (typeof nextUpdate.title === 'string') {
      nextUpdate.title = (nextUpdate.title as string).split(workdir).join('<WORKDIR>');
    }
    if (nextUpdate.rawInput && typeof nextUpdate.rawInput === 'object') {
      const rawInput = nextUpdate.rawInput as Record<string, unknown>;
      if (typeof rawInput.cwd === 'string') rawInput.cwd = '<WORKDIR>';
      if (typeof rawInput.file_path === 'string') {
        rawInput.file_path = (rawInput.file_path as string).split(workdir).join('<WORKDIR>');
      }
    }
    if (nextUpdate.rawOutput && typeof nextUpdate.rawOutput === 'object') {
      const rawOutput = nextUpdate.rawOutput as Record<string, unknown>;
      if (typeof rawOutput.cwd === 'string') rawOutput.cwd = '<WORKDIR>';
    }
    return next as unknown as SessionNotification;
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

e2eDescribe('claude code acp notification updates e2e', () => {
  it('captures notification updates for read, write, terminal, and plan operations', async () => {
    const logger = createSilentLogger();
    const workdir = path.join(os.tmpdir(), 'lody-claude-code-e2e-' + Date.now());
    fs.mkdirSync(workdir, { recursive: true });

    // Create test files
    const readFilePath = path.join(workdir, 'test-read.txt');
    const writeFilePath = path.join(workdir, 'test-write.txt');
    fs.writeFileSync(readFilePath, 'Hello from test file!\nLine 2\nLine 3\n', 'utf8');
    fs.writeFileSync(writeFilePath, 'Original content\n', 'utf8');

    const {
      manager: terminalManager,
      setActiveSessionId,
      getRecords,
    } = createRecordingTerminalManager(workdir, logger);

    const notifications: SessionNotification[] = [];
    let collectedText = '';

    console.log('Starting Claude Code ACP agent with haiku model...');

    const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
      cliType: 'claude',
      workdir,
      logger,
      terminalManager,
      sandbox: true,
      extraArgs: ['--model', 'haiku'],
      onUpdateMessage: (msg) => {
        notifications.push(msg);
        const update = msg.update;
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content &&
          update.content.type === 'text'
        ) {
          collectedText += update.content.text;
        }
        // Log notification type in real-time
        console.log(`[Notification] ${update.sessionUpdate}`, update.toolCallId ?? '');
      },
      onRequestPermission: async (_requestId, request) => {
        console.log('[Permission Request]', request);
        const allow = request.options.find(
          (o) => o.kind === 'allow_once' || o.kind === 'allow_always'
        );
        if (allow) {
          return { outcome: { outcome: 'selected', optionId: allow.optionId } };
        }
        return { outcome: { outcome: 'cancelled' } };
      },
    });

    setActiveSessionId(acpSessionId);

    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    try {
      console.log('Sending prompt to Claude Code...');

      const response = await client?.prompt(acpSessionId, [
        {
          type: 'text',
          text: `Please do the following tasks in order:

1. First, create a simple task plan using TodoWrite with these items:
   - "Read the test file"
   - "Edit the test file"
   - "Run a terminal command"

2. Read the file "test-read.txt" in the current directory and tell me what it contains.

3. Edit the file "test-write.txt" by replacing "Original content" with "Modified by Claude Code".

4. Execute the terminal command: echo "Hello from terminal"

5. After completing all tasks, reply with the single word "DONE".

Work through these tasks systematically.`,
        },
      ]);

      if (response) {
        const ackText = extractTextFromAgentResponse(response);
        if (ackText) {
          collectedText += ackText;
        }
      }

      // Wait for completion
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (collectedText.toUpperCase().includes('DONE')) {
          break;
        }
        await sleep(500);
      }

      console.log('\n=== Test Results ===');
      console.log('Collected text includes DONE:', collectedText.toUpperCase().includes('DONE'));
      console.log('Total notifications:', notifications.length);

      // Check if file was modified
      const writeFileContent = fs.existsSync(writeFilePath)
        ? fs.readFileSync(writeFilePath, 'utf8')
        : '';
      console.log('Write file modified:', writeFileContent.includes('Modified by Claude Code'));

      // Apply notifications to history
      await appendAutonomousACPNotifications(doc, notifications);
      const history = await doc.sessionData.history.readAll();

      // Export notification data
      const fixturesDir = path.join(__dirname, '..', 'fixtures', 'acp');
      fs.mkdirSync(fixturesDir, { recursive: true });

      // Save raw notifications
      const rawNotificationsPath = path.join(
        fixturesDir,
        'claude-code-notifications.captured.json'
      );
      fs.writeFileSync(
        rawNotificationsPath,
        JSON.stringify(sanitizeNotificationsForFixture(notifications, workdir), null, 2),
        'utf8'
      );
      console.log(`\nSaved raw notifications to: ${rawNotificationsPath}`);

      // Save summarized notifications
      const summarizedNotificationsPath = path.join(
        fixturesDir,
        'claude-code-notifications-summarized.captured.json'
      );
      fs.writeFileSync(
        summarizedNotificationsPath,
        JSON.stringify(notifications.map(summarizeNotification), null, 2),
        'utf8'
      );
      console.log(`Saved summarized notifications to: ${summarizedNotificationsPath}`);

      // Save session history
      const historyPath = path.join(fixturesDir, 'claude-code-session-history.captured.json');
      fs.writeFileSync(historyPath, JSON.stringify(summarizeHistory(history), null, 2), 'utf8');
      console.log(`Saved session history to: ${historyPath}`);

      // Save LoroDoc export
      const loroDocPath = path.join(fixturesDir, 'claude-code-session.loro');
      const snapshot = doc.handle?.doc.export({ mode: 'snapshot' });
      if (snapshot) {
        fs.writeFileSync(loroDocPath, Buffer.from(snapshot));
        console.log(`Saved LoroDoc snapshot to: ${loroDocPath}`);
      }

      // Save terminal records
      const terminalRecordsPath = path.join(
        fixturesDir,
        'claude-code-terminal-records.captured.json'
      );
      fs.writeFileSync(terminalRecordsPath, JSON.stringify(getRecords(), null, 2), 'utf8');
      console.log(`Saved terminal records to: ${terminalRecordsPath}`);

      // Log detailed output
      console.log('\n=== Notification Summary ===');
      const notificationTypes = new Map<string, number>();
      for (const n of notifications) {
        const type = n.update.sessionUpdate;
        notificationTypes.set(type, (notificationTypes.get(type) ?? 0) + 1);
      }
      for (const [type, count] of notificationTypes) {
        console.log(`  ${type}: ${count}`);
      }

      console.log('\n=== Tool Calls ===');
      const toolCalls = notifications.filter(
        (n) =>
          n.update.sessionUpdate === 'tool_call' || n.update.sessionUpdate === 'tool_call_update'
      );
      for (const tc of toolCalls) {
        const u = tc.update;
        if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
          console.log(`  [${u.status}] ${u.title ?? u.toolCallId} (kind: ${u.kind ?? 'unknown'})`);
        }
      }

      console.log('\n=== Collected Text Preview ===');
      console.log(collectedText.slice(0, 2000));

      // Assertions
      expect(notifications.length).toBeGreaterThan(0);

      // Check for different notification types
      const hasToolCall = notifications.some(
        (n) =>
          n.update.sessionUpdate === 'tool_call' || n.update.sessionUpdate === 'tool_call_update'
      );
      expect(hasToolCall).toBe(true);

      const hasAgentMessage = notifications.some(
        (n) => n.update.sessionUpdate === 'agent_message_chunk'
      );
      expect(hasAgentMessage).toBe(true);
    } finally {
      if (!agentProcess.killed) {
        try {
          agentProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      await repo.destroy();

      // Cleanup workdir
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }, 180000);
});
