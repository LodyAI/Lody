/**
 * E2E test for Claude Code Terminal Output Parsing
 *
 * This test focuses on terminal command execution with Claude Code to:
 * 1. Capture the raw ACP notification format for terminal operations
 * 2. Verify terminal output is correctly parsed from _meta.claudeCode.toolResponse
 * 3. Test complex terminal scenarios (multiline output, ANSI escapes, exit codes)
 */
import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { LoroRepo } from 'loro-repo';

import type { Logger } from '../../src/utils/logger';
import type { MessageContent, SessionHistoryInput, SessionId, ToolCallContent } from '@lody/shared';
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
    sessionLabel: 'claude-code-terminal-e2e',
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
    case 'tool_call':
    case 'tool_call_update': {
      const terminalCount = (update.content || []).filter((c) => c.type === 'terminal').length;
      const meta = (update as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
      const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
      return {
        sessionUpdate: update.sessionUpdate,
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status,
        kind: update.kind,
        terminalChunks: terminalCount,
        rawInputKeys: update.rawInput ? Object.keys(update.rawInput) : undefined,
        rawOutputPreview: update.rawOutput
          ? JSON.stringify(update.rawOutput).slice(0, 500)
          : undefined,
        // Capture Claude Code specific _meta
        hasClaudeCodeMeta: !!claudeCode,
        claudeCodeToolName: claudeCode?.toolName,
        claudeCodeToolResponse: claudeCode?.toolResponse
          ? JSON.stringify(claudeCode.toolResponse).slice(0, 500)
          : undefined,
      };
    }
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

e2eDescribe('claude code terminal output e2e', () => {
  it('captures terminal output from complex shell commands', async () => {
    const logger = createSilentLogger();
    const workdir = path.join(os.tmpdir(), 'lody-claude-terminal-e2e-' + Date.now());
    fs.mkdirSync(workdir, { recursive: true });

    const {
      manager: terminalManager,
      setActiveSessionId,
      getRecords,
    } = createRecordingTerminalManager(workdir, logger);

    const notifications: SessionNotification[] = [];
    let collectedText = '';

    console.log('Starting Claude Code ACP agent with haiku model for terminal tests...');

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
        const meta = (update as Record<string, unknown>)._meta;
        const hasMeta = !!meta;
        console.log(
          `[Notification] ${update.sessionUpdate}`,
          update.toolCallId ?? '',
          hasMeta ? '(has _meta)' : ''
        );
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
      console.log('Sending complex terminal prompt to Claude Code...');

      const response = await client?.prompt(acpSessionId, [
        {
          type: 'text',
          text: `Execute the following shell commands in sequence and tell me the output of each:

1. Run: echo "Hello World"
2. Run: echo -e "Line1\\nLine2\\nLine3" (to print multiple lines)
3. Run: printf "\\033[31mRed Text\\033[0m\\n" (to print ANSI colored text)
4. Run: seq 1 5 (to print numbers 1-5)
5. Run: ls -la (to list directory contents)

After running all commands, tell me which command had the most interesting output and say "TERMINAL_TEST_DONE".`,
        },
      ]);

      if (response) {
        const ackText = extractTextFromAgentResponse(response);
        if (ackText) {
          collectedText += ackText;
        }
      }

      // Wait for completion
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        if (collectedText.toUpperCase().includes('TERMINAL_TEST_DONE')) {
          break;
        }
        await sleep(500);
      }

      console.log('\n=== Test Results ===');
      console.log(
        'Collected text includes TERMINAL_TEST_DONE:',
        collectedText.toUpperCase().includes('TERMINAL_TEST_DONE')
      );
      console.log('Total notifications:', notifications.length);

      // Apply notifications to history
      await appendAutonomousACPNotifications(doc, notifications);
      const history = await doc.sessionData.history.readAll();

      // Export notification data
      const fixturesDir = path.join(__dirname, '..', 'fixtures', 'acp');
      fs.mkdirSync(fixturesDir, { recursive: true });

      // Save raw notifications
      const rawNotificationsPath = path.join(
        fixturesDir,
        'claude-code-terminal-notifications.captured.json'
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
        'claude-code-terminal-notifications-summarized.captured.json'
      );
      fs.writeFileSync(
        summarizedNotificationsPath,
        JSON.stringify(notifications.map(summarizeNotification), null, 2),
        'utf8'
      );
      console.log(`Saved summarized notifications to: ${summarizedNotificationsPath}`);

      // Save session history
      const historyPath = path.join(
        fixturesDir,
        'claude-code-terminal-session-history.captured.json'
      );
      fs.writeFileSync(historyPath, JSON.stringify(summarizeHistory(history), null, 2), 'utf8');
      console.log(`Saved session history to: ${historyPath}`);

      // Save terminal records
      const terminalRecordsPath = path.join(
        fixturesDir,
        'claude-code-terminal-records.captured.json'
      );
      fs.writeFileSync(terminalRecordsPath, JSON.stringify(getRecords(), null, 2), 'utf8');
      console.log(`Saved terminal records to: ${terminalRecordsPath}`);

      // Log detailed analysis
      console.log('\n=== Notification Type Summary ===');
      const notificationTypes = new Map<string, number>();
      for (const n of notifications) {
        const type = n.update.sessionUpdate;
        notificationTypes.set(type, (notificationTypes.get(type) ?? 0) + 1);
      }
      for (const [type, count] of notificationTypes) {
        console.log(`  ${type}: ${count}`);
      }

      // Find all tool calls with _meta.claudeCode
      console.log('\n=== Claude Code Tool Responses ===');
      const claudeCodeToolCalls = notifications.filter((n) => {
        const meta = (n.update as Record<string, unknown>)._meta as
          | Record<string, unknown>
          | undefined;
        return meta?.claudeCode !== undefined;
      });
      console.log(`Found ${claudeCodeToolCalls.length} notifications with _meta.claudeCode`);

      for (const tc of claudeCodeToolCalls) {
        const update = tc.update as Record<string, unknown>;
        const meta = update._meta as Record<string, unknown>;
        const claudeCode = meta.claudeCode as Record<string, unknown>;
        console.log(`\n  [${update.sessionUpdate}] ${update.toolCallId ?? 'N/A'}`);
        console.log(`    toolName: ${claudeCode.toolName}`);
        if (claudeCode.toolResponse) {
          console.log(
            `    toolResponse: ${JSON.stringify(claudeCode.toolResponse).slice(0, 300)}...`
          );
        }
      }

      // Check history for terminal_output blocks
      console.log('\n=== Session History Terminal Output Analysis ===');
      for (const entry of history) {
        const contents = parseContents(entry);
        const toolCalls = contents.filter((c) => c.type === 'tool_call') as Array<
          Extract<MessageContent, { type: 'tool_call' }>
        >;
        for (const tc of toolCalls) {
          if (tc.kind === 'execute') {
            console.log(`\n  Tool Call: ${tc.toolCallId}`);
            console.log(`    Title: ${tc.title}`);
            console.log(`    Status: ${tc.status}`);
            const contentBlocks = tc.content ?? [];
            const terminalCommands = contentBlocks.filter((b) => b.type === 'terminal_command');
            const terminalOutputs = contentBlocks.filter(
              (b) => b.type === 'terminal_output'
            ) as Array<Extract<ToolCallContent, { type: 'terminal_output' }>>;
            console.log(`    terminal_command blocks: ${terminalCommands.length}`);
            console.log(`    terminal_output blocks: ${terminalOutputs.length}`);
            for (const output of terminalOutputs) {
              console.log(
                `      output (${output.output.length} chars): ${output.output.slice(0, 100)}...`
              );
              console.log(`      truncated: ${output.truncated}`);
            }
            if (terminalOutputs.length === 0) {
              console.log('      WARNING: No terminal_output blocks found!');
              console.log(
                `      All content types: ${contentBlocks.map((b) => b.type).join(', ')}`
              );
            }
          }
        }
      }

      console.log('\n=== Collected Text Preview ===');
      console.log(collectedText.slice(0, 3000));

      // Assertions
      expect(notifications.length).toBeGreaterThan(0);

      // Check for tool calls
      const hasToolCall = notifications.some(
        (n) =>
          n.update.sessionUpdate === 'tool_call' || n.update.sessionUpdate === 'tool_call_update'
      );
      expect(hasToolCall).toBe(true);

      // Check that we have Claude Code meta
      expect(claudeCodeToolCalls.length).toBeGreaterThan(0);
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
  }, 240000);
});
