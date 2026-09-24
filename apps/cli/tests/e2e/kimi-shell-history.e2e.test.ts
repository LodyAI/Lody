/**
 * E2E test: Kimi ACP shell tool → session history parsing.
 *
 * Verifies that when Kimi runs a shell command, the session history correctly
 * contains:
 * - A tool_call entry with a refined title (e.g., "Shell: cat hello.txt")
 * - The shell output as content
 */
import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { LoroRepo } from 'loro-repo';

import type { Logger } from '../../src/utils/logger';
import type { TerminalManager } from '../../src/session/terminal-manager';
import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionId,
} from '@lody/shared';

import { startLocalAcpAgent, shutdownLocalAcpAgent } from '../../src/agent/acp-runner';
import { appendAutonomousACPNotifications } from '../../src/lib/acp/history';
import { SessionDocument } from '../../src/lib/loro/doc';

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

const noopTerminalManager: TerminalManager = {
  createTerminal: async () => {
    throw new Error('Terminal not supported in E2E test');
  },
  terminalOutput: async () => {
    throw new Error('Terminal not supported in E2E test');
  },
  releaseTerminal: async () => {},
  waitForTerminalExit: async () => ({ exitCode: null }),
  killTerminal: async () => {},
};

const parseContents = (entry: SessionHistoryInput): MessageContent[] => {
  if (Array.isArray(entry.items)) {
    return entry.items as unknown as MessageContent[];
  }
  return [];
};

const runE2E = process.env.LODY_E2E === '1';
const e2eDescribe = runE2E ? describe : describe.skip;

e2eDescribe('kimi shell tool history parsing', () => {
  it('persists shell command title and output into session history', async () => {
    const logger = createSilentLogger();
    const workdir = path.join(os.tmpdir(), 'lody-e2e-kimi-shell-history');
    fs.mkdirSync(workdir, { recursive: true });

    const notifications: AcpSessionNotification[] = [];
    const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
      cliType: 'registry',
      agentType: 'kimi',
      workdir,
      logger,
      terminalManager: noopTerminalManager,
      onUpdateMessage: (msg) => {
        notifications.push(msg);
      },
      onRequestPermission: async (_id, req) => {
        // Use ACP 0.18 format: select the first "allow" option
        const allowOption = req.options?.find(
          (o: { kind?: string }) => o.kind === 'allow_once' || o.kind === 'allow_always'
        );
        if (allowOption) {
          return { outcome: { outcome: 'selected', optionId: allowOption.optionId } } as any;
        }
        return { outcome: { outcome: 'cancelled' } };
      },
    });

    try {
      // Ask Kimi to run a simple echo command
      await client.prompt(acpSessionId, [
        {
          type: 'text',
          text: 'Run `echo lody_kimi_test_output` in the shell. Only use the shell tool, do not use any other tool.',
        },
      ]);

      // Process all collected notifications into a session history doc
      const sessionId = uuidv4() as SessionId;
      const repo = await LoroRepo.create({});
      const doc = new SessionDocument(repo, sessionId);
      await doc.initOffline();

      await appendAutonomousACPNotifications(doc, notifications);
      const history = await doc.sessionData.history.readAll();

      // Find all tool_call items
      const toolCalls = history.flatMap((h) =>
        parseContents(h).filter(
          (c): c is Extract<MessageContent, { type: 'tool_call' }> => c.type === 'tool_call'
        )
      );

      console.log(
        '\n=== Tool calls in history ===\n',
        JSON.stringify(
          toolCalls.map((tc) => ({
            title: tc.title,
            kind: tc.kind,
            status: tc.status,
            contentTypes: tc.content?.map((c) => c.type),
          })),
          null,
          2
        )
      );

      // There should be at least one tool_call (the shell command)
      expect(toolCalls.length).toBeGreaterThan(0);

      // Find the shell tool call — Kimi titles shell tools as "Shell: <command>"
      const shellToolCall = toolCalls.find((tc) => tc.title?.toLowerCase().includes('shell'));
      expect(shellToolCall).toBeDefined();

      // === Key assertion 1: title propagation ===
      // The title should contain the command, propagated from the in-progress updates
      // that were filtered out. Without propagateToolCallState this would be just "Shell".
      console.log(`\n=== Shell tool title: ${shellToolCall!.title} ===`);
      expect(shellToolCall!.title).toContain('echo');

      // === Key assertion 2: content is preserved ===
      // The tool call should have content blocks from the completed/failed update.
      expect(shellToolCall!.content).toBeDefined();
      expect(shellToolCall!.content!.length).toBeGreaterThan(0);

      const allContentText = shellToolCall!
        .content!.map((c) => {
          if (c.type === 'terminal_output') return c.output;
          if (c.type === 'terminal_command') return c.command;
          if (c.type === 'content' && 'content' in c && c.content.type === 'text')
            return c.content.text;
          return '';
        })
        .join(' ');
      console.log(`\n=== Shell tool content text: ${allContentText} ===`);

      // If shell execution succeeded, the output should contain our marker
      if (shellToolCall!.status === 'completed') {
        expect(allContentText).toContain('lody_kimi_test_output');
      }
      // If it failed (e.g., sandbox restrictions), content should still be non-empty
      // (Kimi sends an error message in the content)
      expect(allContentText.length).toBeGreaterThan(0);
    } finally {
      await shutdownLocalAcpAgent({
        agentProcess,
        client,
        acpSessionId,
        logger,
        sessionLabel: 'e2e-kimi-shell-history',
      });
    }
  }, 120_000);
});
