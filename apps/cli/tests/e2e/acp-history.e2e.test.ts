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
import { CodexToolRawOutputSchema } from '../../src/lib/acp/codex-raw';

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

const findToolCallInHistory = (
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

const createRecordingTerminalManager = (workdir: string, logger: Logger) => {
  let activeSessionId: string | null = null;
  const base = new ShellTerminalManager({
    logger,
    sessionLabel: 'acp-history-e2e',
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
    const update = n.update as any;
    const next: any = {
      ...n,
      sessionId: 'session-captured',
      update: { ...update },
    };
    if (typeof next.update.title === 'string') {
      next.update.title = next.update.title.split(workdir).join('<WORKDIR>');
    }
    if (next.update.rawInput && typeof next.update.rawInput === 'object') {
      if (typeof next.update.rawInput.cwd === 'string') next.update.rawInput.cwd = '<WORKDIR>';
    }
    if (next.update.rawOutput && typeof next.update.rawOutput === 'object') {
      if (typeof next.update.rawOutput.cwd === 'string') next.update.rawOutput.cwd = '<WORKDIR>';
    }
    return next as SessionNotification;
  });

const noopTerminalManager: TerminalManager = {
  createTerminal: async () => {
    throw new Error('Terminal not supported in baseline E2E test');
  },
  terminalOutput: async () => {
    throw new Error('Terminal not supported in baseline E2E test');
  },
  releaseTerminal: async () => {},
  waitForTerminalExit: async () => ({ exitCode: null }),
  killTerminal: async () => {},
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

e2eDescribe('acp history e2e (codex stream)', () => {
  it('streams codex output and persists parsed history into offline loro doc', async () => {
    const logger = createSilentLogger();
    const workdir = path.join(os.tmpdir(), 'lody-acp-history-e2e');
    fs.mkdirSync(workdir, { recursive: true });

    const notifications: SessionNotification[] = [];
    let collectedText = '';

    const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
      cliType: 'codex',
      workdir,
      logger,
      terminalManager: noopTerminalManager,
      sandbox: true,
      extraArgs: ['-c', 'model="gpt-5.1-codex-mini"', '-c', 'model_reasoning_effort="low"'],
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
      },
      onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });

    const sessionId = uuidv4() as SessionId;
    const repo = await LoroRepo.create({});
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    try {
      const response = await client?.prompt(acpSessionId, [
        {
          type: 'text',
          text: 'Reply with the single word "pong".',
        },
      ]);
      if (response) {
        const ackText = extractTextFromAgentResponse(response);
        if (ackText) {
          collectedText += ackText;
        }
      }

      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (collectedText.toLowerCase().includes('pong')) {
          break;
        }
        await sleep(200);
      }

      expect(collectedText.toLowerCase()).toContain('pong');

      await appendAutonomousACPNotifications(doc, notifications);

      const history = await doc.sessionData.history.readAll();
      const allText = history
        .flatMap((h) => parseContents(h))
        .filter((c) => c.type === 'text')
        .map((c) => (c as Extract<MessageContent, { type: 'text' }>).text)
        .join('');

      expect(allText.toLowerCase()).toContain('pong');
    } finally {
      if (!agentProcess.killed) {
        try {
          agentProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      await repo.destroy();
    }
  }, 120000);

  it('captures terminal + diff tool calls and logs flow for inspection', async () => {
    const logger = createSilentLogger();
    const workdir = path.join(os.tmpdir(), 'lody-acp-history-e2e-tools');
    fs.mkdirSync(workdir, { recursive: true });

    const targetPath = path.join(workdir, 'acp-history-target.txt');
    fs.writeFileSync(targetPath, 'start\n', 'utf8');
    const listingPath = path.join(workdir, 'acp-history-listing.txt');
    fs.writeFileSync(listingPath, '', 'utf8');

    const {
      manager: terminalManager,
      setActiveSessionId,
      getRecords,
    } = createRecordingTerminalManager(workdir, logger);

    const notifications: SessionNotification[] = [];
    let collectedText = '';

    const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
      cliType: 'codex',
      workdir,
      logger,
      terminalManager,
      sandbox: true,
      extraArgs: [
        '-c',
        'trust_level="trusted"',
        '-c',
        'include_apply_patch_tool=true',
        '-c',
        'model="gpt-5.1-codex-mini"',
        '-c',
        'model_reasoning_effort="low"',
      ],
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
      },
      onRequestPermission: async (_requestId, request) => {
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
    const doc = new SessionDocument(repo, uuidv4() as SessionId);
    await doc.initOffline();

    try {
      const response = await client?.prompt(acpSessionId, [
        {
          type: 'text',
          text:
            'First, use the terminal/execute tool to run the shell command `printf "\\033[31mred\\033[0m\\n"` in the current working directory, without redirecting output. ' +
            'This must print ANSI color escapes to stdout. ' +
            'Second, use the terminal/execute tool to run the shell command `ls -1` in the current working directory. ' +
            'Take the exact stdout and write it verbatim into the file "acp-history-listing.txt" (create or edit as needed). ' +
            'Do not use file listing/search tools for this step; use a real shell command. ' +
            'Third, use a terminal command to overwrite "acp-history-target.txt" so that its entire content becomes exactly the single line "done". ' +
            'For example, you may run a shell command like `printf "done\\n" > acp-history-target.txt`. ' +
            'Do not merely describe changes; actually modify the file. ' +
            'After finishing all steps, reply with the single word "completed".',
        },
      ]);
      if (response) {
        const ackText = extractTextFromAgentResponse(response);
        if (ackText) {
          collectedText += ackText;
        }
      }

      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (collectedText.toLowerCase().includes('completed')) {
          break;
        }
        await sleep(200);
      }

      const completedSeen = collectedText.toLowerCase().includes('completed');

      const fileDeadline = Date.now() + 20000;
      let fileAfter = '';
      while (Date.now() < fileDeadline) {
        fileAfter = fs.readFileSync(targetPath, 'utf8').trim();
        if (fileAfter.toLowerCase().includes('done')) {
          break;
        }
        await sleep(500);
      }

      const listingAfter = fs.existsSync(listingPath) ? fs.readFileSync(listingPath, 'utf8') : '';

      const rawOutputCandidates = notifications
        .map((n) => n.update)
        .filter((u) => u.sessionUpdate === 'tool_call_update')
        .map((u) => (u.sessionUpdate === 'tool_call_update' ? u.rawOutput : undefined))
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);

      // Codex-specific: ensure the current "low output" schema did not drift.
      // `rawOutput` is explicitly unstructured by ACP spec, so this assertion is intentionally strict
      // for Codex, and will fail if the agent's raw output format changes.
      expect(rawOutputCandidates.length).toBeGreaterThan(0);
      for (const raw of rawOutputCandidates) {
        const parsed = CodexToolRawOutputSchema.safeParse(raw);
        if (!parsed.success) {
          console.log('=== Codex Raw Output Schema Mismatch ===');
          console.log(JSON.stringify({ keys: Object.keys(raw) }, null, 2));
          console.log(JSON.stringify(raw, null, 2).slice(0, 4000));
        }
        expect(parsed.success).toBe(true);
      }

      await appendAutonomousACPNotifications(doc, notifications);
      const history = await doc.sessionData.history.readAll();
      const summarizedHistory = summarizeHistory(history);

      console.log('=== ACP E2E Debug ===');
      console.log(
        JSON.stringify(
          {
            completedSeen,
            collectedTextPreview: collectedText.slice(0, 4000),
            notificationsCount: notifications.length,
            fileAfter,
            listingAfterPreview: listingAfter.slice(0, 2000),
          },
          null,
          2
        )
      );
      console.log('=== ACP Notifications (summarized) ===');
      console.log(JSON.stringify(notifications.map(summarizeNotification), null, 2));
      console.log('=== Terminal RPC Records ===');
      console.log(JSON.stringify(getRecords(), null, 2));
      console.log('=== Listing File (stdout) ===');
      console.log(listingAfter.slice(0, 2000));
      console.log('=== Final Session History (parsed) ===');
      console.log(JSON.stringify(summarizedHistory, null, 2));

      if (process.env.LODY_E2E_CAPTURE_FIXTURE === '1') {
        const fixturePath = path.join(
          __dirname,
          '..',
          'fixtures',
          'acp',
          'codex-terminal-notifications.captured.json'
        );
        fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
        fs.writeFileSync(
          fixturePath,
          JSON.stringify(sanitizeNotificationsForFixture(notifications, workdir), null, 2),
          'utf8'
        );
        console.log(`=== Captured Notifications Fixture ===\n${fixturePath}`);
      }

      expect(fileAfter.toLowerCase()).toContain('done');
      expect(listingAfter.length).toBeGreaterThan(0);
      expect(listingAfter).toContain('acp-history-target.txt');

      const hasToolCall = notifications.some(
        (n) =>
          n.update.sessionUpdate === 'tool_call' || n.update.sessionUpdate === 'tool_call_update'
      );
      expect(hasToolCall).toBe(true);

      const allText = summarizedHistory
        .flatMap((h) => h.contents)
        .filter((c) => c.type === 'text')
        .map((c) => (c as Extract<MessageContent, { type: 'text' }>).text)
        .join('');
      expect(allText.length).toBeGreaterThan(0);

      const toolCalls = summarizedHistory
        .flatMap((h) => h.contents)
        .filter((c) => c.type === 'tool_call') as Array<
        Extract<MessageContent, { type: 'tool_call' }>
      >;
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(
        toolCalls.some((tc) => (tc.content || []).some((b) => b.type === 'terminal_output'))
      ).toBe(true);

      const hasAnsi = toolCalls.some((tc) =>
        (tc.content || []).some(
          (b) => b.type === 'terminal_output' && b.output.includes('\u001b[31mred\u001b[0m')
        )
      );
      expect(hasAnsi).toBe(true);
    } finally {
      if (!agentProcess.killed) {
        try {
          agentProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      await repo.destroy();
    }
  }, 180000);

  it('does not store read/edit payloads, compacts streaming output, and truncates terminal output to 1K', async () => {
    const logger = createSilentLogger();
    const workdir = path.join(os.tmpdir(), 'lody-acp-history-e2e-compact');
    fs.mkdirSync(workdir, { recursive: true });

    const readFileName = 'acp-history-read.txt';
    const editFileName = 'acp-history-edit.txt';
    const readFilePath = path.join(workdir, readFileName);
    const editFilePath = path.join(workdir, editFileName);

    const readSentinel = 'READ_SENTINEL_0e60f45c';
    const oldSentinel = 'EDIT_SENTINEL_OLD_0fdab44e';
    const newSentinel = 'EDIT_SENTINEL_NEW_3f0c1d73';

    fs.writeFileSync(readFilePath, `${readSentinel}\nalpha\nbeta\n`, 'utf8');
    fs.writeFileSync(editFilePath, `${oldSentinel}\nalpha\nbeta\n`, 'utf8');

    const { manager: terminalManager, setActiveSessionId } = createRecordingTerminalManager(
      workdir,
      logger
    );

    const notifications: SessionNotification[] = [];
    let collectedText = '';

    const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
      cliType: 'codex',
      workdir,
      logger,
      terminalManager,
      sandbox: true,
      extraArgs: [
        '-c',
        'trust_level="trusted"',
        '-c',
        'include_apply_patch_tool=true',
        '-c',
        'model="gpt-5.1-codex-mini"',
        '-c',
        'model_reasoning_effort="low"',
      ],
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
      },
      onRequestPermission: async (_requestId, request) => {
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
    const doc = new SessionDocument(repo, uuidv4() as SessionId);
    await doc.initOffline();

    try {
      const start = performance.now();
      const response = await client?.prompt(acpSessionId, [
        {
          type: 'text',
          text:
            `Do the following steps using tools:\n` +
            `1) Read the file "${readFileName}" using a terminal/execute tool call (for example: \`sed -n '1,120p' ${readFileName}\`). Do not paste the file content into your reply.\n` +
            `2) Edit the file "${editFileName}" by replacing the exact string "${oldSentinel}" with "${newSentinel}" using the \`apply_patch\` tool. Do NOT use terminal/execute for this step. Do not paste the file content into your reply.\n` +
            `3) Run a terminal/execute command that prints 200 lines slowly so output streams in multiple updates. Use:\n` +
            `   for i in $(seq 1 200); do echo "line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; sleep 0.02; done\n` +
            `After all steps are done, reply with the single word "done".`,
        },
      ]);
      console.log('Prompt takes', performance.now() - start);
      if (response) {
        const ackText = extractTextFromAgentResponse(response);
        if (ackText) {
          collectedText += ackText;
        }
      }

      // Wait for: file edited on disk, read output observed, edit diff observed, and streamed output observed.
      const deadline = Date.now() + 180000;
      let editAppliedOnDisk = false;
      let readObserved = false;
      let editObserved = false;
      let executeObserved = false;
      while (Date.now() < deadline) {
        if (!editAppliedOnDisk) {
          const edited = fs.readFileSync(editFilePath, 'utf8');
          editAppliedOnDisk = !edited.includes(oldSentinel) && edited.includes(newSentinel);
        }
        if (!readObserved) {
          readObserved = notifications.some((msg) => {
            const u = msg.update;
            if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')
              return false;
            return JSON.stringify(u).includes(readSentinel);
          });
        }
        if (!editObserved) {
          editObserved = notifications.some((msg) => {
            const u = msg.update;
            if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')
              return false;
            const blocks = u.content ?? [];
            return blocks.some(
              (b) =>
                b.type === 'diff' &&
                (b.oldText ?? '').includes(oldSentinel) &&
                b.newText.includes(newSentinel)
            );
          });
        }
        if (!executeObserved) {
          executeObserved = notifications.some((msg) => {
            const u = msg.update;
            if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')
              return false;
            const inputText = u.rawInput ? JSON.stringify(u.rawInput) : '';
            if (inputText.includes('seq 1 200') || inputText.includes('line-$i-')) return true;
            return JSON.stringify(u).includes('seq 1 200');
          });
        }
        if (editAppliedOnDisk && readObserved && editObserved && executeObserved) {
          break;
        }
        await sleep(200);
      }

      expect(editAppliedOnDisk).toBe(true);
      expect(readObserved).toBe(true);
      expect(editObserved).toBe(true);
      expect(executeObserved).toBe(true);

      // Find tool call IDs from notifications.
      let readToolCallId: string | null = null;
      let editToolCallId: string | null = null;
      for (const msg of notifications) {
        const u = msg.update;
        if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') continue;

        if (!readToolCallId) {
          // Prefer the update that actually contains the file text (sentinel).
          if (JSON.stringify(u).includes(readSentinel)) {
            readToolCallId = u.toolCallId;
          } else if (
            (u.title && u.title.includes(readFileName)) ||
            (u.locations || []).some((l) => l.path.endsWith(readFileName))
          ) {
            readToolCallId = u.toolCallId;
          }
        }

        if (!editToolCallId) {
          const blocks = u.content ?? [];
          const hasDiff = blocks.some(
            (b) =>
              b.type === 'diff' &&
              (b.oldText ?? '').includes(oldSentinel) &&
              b.newText.includes(newSentinel)
          );
          if (hasDiff) {
            editToolCallId = u.toolCallId;
          } else if (
            (u.title && u.title.includes(editFileName)) ||
            (u.locations || []).some((l) => l.path.endsWith(editFileName))
          ) {
            editToolCallId = u.toolCallId;
          }
        }
      }

      let executeToolCallId: string | null = null;
      for (const msg of notifications) {
        const u = msg.update;
        if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') continue;

        // Prefer identifying via rawInput (stable even when the agent truncates output).
        const inputText = u.rawInput ? JSON.stringify(u.rawInput) : '';
        if (inputText.includes('seq 1 200') || inputText.includes('line-$i-')) {
          executeToolCallId = u.toolCallId;
          break;
        }
        if (JSON.stringify(u).includes('seq 1 200')) {
          executeToolCallId = u.toolCallId;
          break;
        }

        // Fallback: detect via streamed output (rawOutput/content).
        if (u.rawOutput) {
          const parsed = CodexToolRawOutputSchema.safeParse(u.rawOutput);
          if (parsed.success) {
            const candidate =
              parsed.data.output ??
              parsed.data.aggregated_output ??
              parsed.data.stdout ??
              parsed.data.formatted_output;
            if (typeof candidate === 'string' && candidate.includes('line-200-')) {
              executeToolCallId = u.toolCallId;
              break;
            }
          }
        }

        if ((u.content ?? []).some((b) => JSON.stringify(b).includes('line-200-'))) {
          executeToolCallId = u.toolCallId;
          break;
        }
      }

      expect(readToolCallId).toBeTruthy();
      expect(editToolCallId).toBeTruthy();
      expect(executeToolCallId).toBeTruthy();

      // Ensure the raw notifications actually contained the file contents / diffs we want to avoid persisting.
      const readNotificationIncludesFileText = notifications.some((msg) => {
        const u = msg.update;
        if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return false;
        if (u.toolCallId !== readToolCallId) return false;
        return JSON.stringify(u).includes(readSentinel);
      });
      expect(readNotificationIncludesFileText).toBe(true);

      const editNotificationIncludesDiff = notifications.some((msg) => {
        const u = msg.update;
        if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return false;
        if (u.toolCallId !== editToolCallId) return false;
        const blocks = u.content ?? [];
        return blocks.some(
          (b) =>
            b.type === 'diff' &&
            (b.oldText ?? '').includes(oldSentinel) &&
            b.newText.includes(newSentinel)
        );
      });
      expect(editNotificationIncludesDiff).toBe(true);

      const executeUpdateCount = notifications.filter((msg) => {
        const u = msg.update;
        return u.sessionUpdate === 'tool_call_update' && u.toolCallId === executeToolCallId;
      }).length;
      expect(executeUpdateCount).toBeGreaterThan(1);

      const editCalls: unknown[] = [];
      await appendAutonomousACPNotifications(doc, notifications, {
        editCallback: (edits) => {
          editCalls.push(...edits);
        },
      });
      console.log(JSON.stringify(editCalls, null, 2));
      const history = await doc.sessionData.history.readAll();
      // fs.writeFileSync("./e2e-notifications.json", JSON.stringify(notifications, null, 2));
      // fs.writeFileSync("./e2e-history.json", JSON.stringify(history, null, 2));

      // Read: do not store terminal output / content.
      const readTool = findToolCallInHistory(history, readToolCallId!);
      expect(readTool).not.toBeNull();
      expect(readTool?.locations?.some((l) => l.path.endsWith(readFileName))).toBe(true);
      const readBlocks = readTool?.content ?? [];
      expect(readBlocks.some((b) => b.type === 'terminal_output')).toBe(false);
      expect(readBlocks.some((b) => b.type === 'content')).toBe(false);
      expect(readBlocks.some((b) => b.type === 'diff')).toBe(false);
      // Ensure the read file content isn't persisted inside tool call blocks.
      expect(JSON.stringify(readBlocks).includes(readSentinel)).toBe(false);

      // Edit: do not store diffs / content blocks (old/new text).
      const editTool = findToolCallInHistory(history, editToolCallId!);
      expect(editTool).not.toBeNull();
      expect(editTool?.locations?.some((l) => l.path.endsWith(editFileName))).toBe(true);
      const editBlocks = editTool?.content ?? [];
      expect(editBlocks.some((b) => b.type === 'diff')).toBe(false);
      expect(editBlocks.some((b) => b.type === 'content')).toBe(false);
      expect(JSON.stringify(editBlocks).includes(oldSentinel)).toBe(false);
      expect(JSON.stringify(editBlocks).includes(newSentinel)).toBe(false);

      // Execute: collapse snapshot streaming into a single terminal_output and keep at most 1K chars.
      const execTool = findToolCallInHistory(history, executeToolCallId!);
      expect(execTool).not.toBeNull();
      const execBlocks = execTool?.content ?? [];
      expect(execBlocks.some((b) => b.type === 'content')).toBe(false);
      const execOutputs = execBlocks.filter((b) => b.type === 'terminal_output') as Array<{
        type: 'terminal_output';
        output: string;
        truncated?: boolean;
      }>;
      expect(execOutputs.length).toBeGreaterThan(0);
      const combined = execOutputs[execOutputs.length - 1];
      expect(combined.output.length).toBeLessThanOrEqual(1024);
      expect(combined.truncated).toBe(true);
      expect(combined.output.includes('line-200-')).toBe(true);
    } finally {
      if (!agentProcess.killed) {
        try {
          agentProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      await repo.destroy();
    }
  }, 240000);
});
