/**
 * E2E test for Claude Code ACP with Extended Thinking
 *
 * This test uses the Sonnet model with a complex problem that should
 * trigger extended thinking, to see if agent_thought_chunk notifications
 * are included in ACP updates.
 */
import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { LoroRepo } from 'loro-repo';

import type { Logger } from '../../src/utils/logger';
import type { SessionId } from '@lody/shared';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { startLocalAcpAgent } from '../../src/agent/acp-runner';
import { extractTextFromAgentResponse } from '../../src/agent/response-utils';
import { ShellTerminalManager } from '../../src/session/terminal-manager';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      };
    }
    case 'plan':
      return { sessionUpdate: 'plan', entries: update.entries };
    default:
      return { sessionUpdate: update.sessionUpdate };
  }
};

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
    return next as unknown as SessionNotification;
  });

e2eDescribe('claude code thinking e2e', () => {
  it('checks if extended thinking produces agent_thought_chunk notifications', async () => {
    const logger = createSilentLogger();
    const workdir = path.join(os.tmpdir(), 'lody-claude-thinking-e2e-' + Date.now());
    fs.mkdirSync(workdir, { recursive: true });

    let activeSessionId: string | null = null;
    const terminalManager = new ShellTerminalManager({
      logger,
      sessionLabel: 'claude-thinking-e2e',
      getActiveAcpSessionId: () => activeSessionId,
      resolveWorkdir: (cwd?: string) => cwd ?? workdir,
      buildEnv: (overrides?: Record<string, string>) => ({ ...process.env, ...overrides }),
    });

    const notifications: SessionNotification[] = [];
    let collectedText = '';
    let thoughtChunks: Array<{ text: string }> = [];

    console.log('Starting Claude Code ACP agent with sonnet model...');

    const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
      cliType: 'claude',
      workdir,
      logger,
      terminalManager,
      sandbox: true,
      extraArgs: ['--model', 'sonnet'],
      onUpdateMessage: (msg) => {
        notifications.push(msg);
        const update = msg.update;

        if (update.sessionUpdate === 'agent_thought_chunk') {
          console.log('[THINKING]', JSON.stringify(update).slice(0, 500));
          if (update.content && update.content.type === 'text') {
            thoughtChunks.push({ text: update.content.text });
          }
        }

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

    activeSessionId = acpSessionId;

    const repo = await LoroRepo.create({});
    const sessionId = uuidv4() as SessionId;
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();

    try {
      console.log('Sending complex prompt requiring deep thinking...');

      // A complex problem that should trigger extended thinking
      const response = await client?.prompt(acpSessionId, [
        {
          type: 'text',
          text: `I need you to think deeply about this problem. Please use extended thinking to reason through it step by step.

PROBLEM: Design a lock-free concurrent hash map data structure in Rust that:
1. Supports concurrent reads and writes without blocking
2. Uses atomic operations for thread safety
3. Handles hash collisions using open addressing
4. Implements resize operations without stopping the world
5. Provides linearizable operations

Think through the following aspects carefully:
- Memory ordering requirements for each operation
- How to handle concurrent resize operations
- The ABA problem and how to avoid it
- Memory reclamation strategy (hazard pointers vs epoch-based)

After your deep analysis, summarize your key insights in 3 bullet points and end with "ANALYSIS COMPLETE".`,
        },
      ]);

      if (response) {
        const ackText = extractTextFromAgentResponse(response);
        if (ackText) {
          collectedText += ackText;
        }
      }

      // Wait for completion
      const deadline = Date.now() + 180000; // 3 minutes for complex thinking
      while (Date.now() < deadline) {
        if (collectedText.toUpperCase().includes('ANALYSIS COMPLETE')) {
          break;
        }
        await sleep(500);
      }

      console.log('\n=== Test Results ===');
      console.log(
        'Collected text includes ANALYSIS COMPLETE:',
        collectedText.toUpperCase().includes('ANALYSIS COMPLETE')
      );
      console.log('Total notifications:', notifications.length);

      // Apply notifications to history
      await appendAutonomousACPNotifications(doc, notifications);

      // Analyze notification types
      console.log('\n=== Notification Type Summary ===');
      const notificationTypes = new Map<string, number>();
      for (const n of notifications) {
        const type = n.update.sessionUpdate;
        notificationTypes.set(type, (notificationTypes.get(type) ?? 0) + 1);
      }
      for (const [type, count] of notificationTypes) {
        console.log(`  ${type}: ${count}`);
      }

      // Check for thinking chunks
      console.log('\n=== Extended Thinking Analysis ===');
      console.log('agent_thought_chunk count:', thoughtChunks.length);
      if (thoughtChunks.length > 0) {
        console.log('Thinking content preview:');
        for (const chunk of thoughtChunks.slice(0, 5)) {
          console.log(`  - ${chunk.text.slice(0, 200)}...`);
        }
      } else {
        console.log('NO agent_thought_chunk notifications received!');
        console.log('Claude Code ACP does not expose extended thinking in notifications.');
      }

      // Save results
      const fixturesDir = path.join(__dirname, '..', 'fixtures', 'acp');
      fs.mkdirSync(fixturesDir, { recursive: true });

      // Save raw notifications
      const rawNotificationsPath = path.join(
        fixturesDir,
        'claude-code-thinking-notifications.captured.json'
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
        'claude-code-thinking-notifications-summarized.captured.json'
      );
      fs.writeFileSync(
        summarizedNotificationsPath,
        JSON.stringify(notifications.map(summarizeNotification), null, 2),
        'utf8'
      );
      console.log(`Saved summarized notifications to: ${summarizedNotificationsPath}`);

      // Save session history
      const history = await doc.sessionData.history.readAll();
      const summarizeHistory = (historyEntries: SessionHistoryInput[]) =>
        historyEntries.map((h) => ({
          id: h.id,
          role: h.role,
          timestamp: h.timestamp,
          contents: Array.isArray(h.items) ? (h.items as unknown as MessageContent[]) : [],
          // Plan is now a separate field on the history entry, not in contents
          plan: h.plan,
        }));
      const historyPath = path.join(
        fixturesDir,
        'claude-code-thinking-session-history.captured.json'
      );
      fs.writeFileSync(historyPath, JSON.stringify(summarizeHistory(history), null, 2), 'utf8');
      console.log(`Saved session history to: ${historyPath}`);

      const thinkingResultPath = path.join(fixturesDir, 'claude-code-thinking-result.json');
      fs.writeFileSync(
        thinkingResultPath,
        JSON.stringify(
          {
            model: 'sonnet',
            totalNotifications: notifications.length,
            notificationTypeCounts: Object.fromEntries(notificationTypes),
            hasThoughtChunks: thoughtChunks.length > 0,
            thoughtChunkCount: thoughtChunks.length,
            thoughtChunks: thoughtChunks.slice(0, 10),
            collectedTextPreview: collectedText.slice(0, 2000),
          },
          null,
          2
        ),
        'utf8'
      );
      console.log(`Saved thinking analysis to: ${thinkingResultPath}`);

      // Log response preview
      console.log('\n=== Response Preview ===');
      console.log(collectedText.slice(0, 3000));

      // Assertions
      expect(notifications.length).toBeGreaterThan(0);

      // Log conclusion about thinking
      console.log('\n=== CONCLUSION ===');
      if (thoughtChunks.length > 0) {
        console.log(
          'SUCCESS: Claude Code ACP DOES expose extended thinking via agent_thought_chunk'
        );
      } else {
        console.log('FINDING: Claude Code ACP does NOT expose extended thinking in notifications');
        console.log('(Unlike Codex which has agent_thought_chunk in its ACP implementation)');
      }
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
  }, 240000); // 4 minute timeout for complex thinking
});
