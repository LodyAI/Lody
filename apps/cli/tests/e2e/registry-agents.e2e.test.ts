/**
 * E2E test for registry ACP agents (OpenCode, Kimi)
 *
 * Verifies that the ACP flow works end-to-end:
 * - newSession returns modes/models/configOptions
 * - prompt sends a message and receives a response
 * - setSessionMode / setSessionConfigOption works
 * - loadSession / resumeSession works
 */
import { describe, expect, it, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import * as fs from 'fs';
import type { ChildProcess } from 'child_process';

import type { Logger } from '../../src/utils/logger';
import type { TerminalManager } from '../../src/session/terminal-manager';
import type { AcpSessionNotification, AgentConfigCliType } from '@lody/shared';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

import {
  startLocalAcpAgent,
  shutdownLocalAcpAgent,
  spawnAcpProcess,
  createAcpClient,
} from '../../src/agent/acp-runner';
import { extractTextFromAgentResponse } from '../../src/agent/response-utils';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createStdinWritableStream, createStdoutReadableStream } from '../../src/utils/stream';

const createDebugLogger = (): Logger => ({
  info: (...args: unknown[]) => console.log('[INFO]', ...args),
  warn: (...args: unknown[]) => console.warn('[WARN]', ...args),
  error: (...args: unknown[]) => console.error('[ERROR]', ...args),
  success: (...args: unknown[]) => console.log('[SUCCESS]', ...args),
  debug: (...args: unknown[]) => console.log('[DEBUG]', ...args),
  trace: (...args: unknown[]) => console.log('[DEBUG]', ...args),
  setLevel: () => {},
  child: () => createDebugLogger(),
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

const runE2E = process.env.LODY_E2E === '1';
const e2eDescribe = runE2E ? describe : describe.skip;

type AgentTestConfig = {
  cliType: AgentConfigCliType;
  agentType: string;
  displayName: string;
};

const REGISTRY_AGENTS: AgentTestConfig[] = [
  { cliType: 'registry', agentType: 'opencode', displayName: 'OpenCode' },
  { cliType: 'registry', agentType: 'kimi', displayName: 'Kimi' },
  { cliType: 'registry', agentType: 'kimi-code', displayName: 'Kimi Code CLI' },
];

e2eDescribe('registry agents ACP e2e', () => {
  const processes: ChildProcess[] = [];

  afterEach(async () => {
    for (const p of processes) {
      if (!p.killed) {
        try {
          p.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
    processes.length = 0;
  });

  for (const agent of REGISTRY_AGENTS) {
    describe(agent.displayName, () => {
      it(
        'newSession returns modes/models/configOptions',
        async () => {
          const logger = createDebugLogger();
          const workdir = path.join(os.tmpdir(), `lody-e2e-${agent.agentType}-newsession`);
          fs.mkdirSync(workdir, { recursive: true });

          const notifications: AcpSessionNotification[] = [];
          const { agentProcess, client, acpSessionId, sessionResponse } =
            await startLocalAcpAgent({
              cliType: agent.cliType,
              agentType: agent.agentType,
              workdir,
              logger,
              terminalManager: noopTerminalManager,
              onUpdateMessage: (msg) => {
                notifications.push(msg);
              },
              onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            });
          processes.push(agentProcess);

          console.log(
            `\n=== ${agent.displayName} newSession ===`,
            JSON.stringify(
              {
                sessionId: sessionResponse.sessionId,
                modes: sessionResponse.modes,
                models: sessionResponse.models,
                configOptions: sessionResponse.configOptions?.map((o) => ({
                  id: o.id,
                  type: o.type,
                  category: (o as { category?: string }).category,
                  name: o.name,
                })),
              },
              null,
              2
            )
          );

          // Verify session was created
          expect(acpSessionId).toBeTruthy();
          expect(sessionResponse.sessionId).toBeTruthy();

          // Check modes or configOptions
          const hasModes =
            sessionResponse.modes?.availableModes &&
            sessionResponse.modes.availableModes.length > 0;
          const hasConfigModeOption = sessionResponse.configOptions?.some(
            (o) => (o as { category?: string }).category === 'mode'
          );
          console.log(
            `${agent.displayName}: hasModes=${hasModes}, hasConfigModeOption=${hasConfigModeOption}`
          );

          // Check models or configOptions
          const hasModels =
            sessionResponse.models?.availableModels &&
            sessionResponse.models.availableModels.length > 0;
          const hasConfigModelOption = sessionResponse.configOptions?.some(
            (o) => (o as { category?: string }).category === 'model'
          );
          console.log(
            `${agent.displayName}: hasModels=${hasModels}, hasConfigModelOption=${hasConfigModelOption}`
          );

          // At least one of modes/models/configOptions should be present
          expect(hasModes || hasConfigModeOption || hasModels || hasConfigModelOption).toBe(true);

          await shutdownLocalAcpAgent({
            agentProcess,
            client,
            acpSessionId,
            logger,
            sessionLabel: `e2e-${agent.agentType}`,
          });
        },
        120_000
      );

      it(
        'prompt returns a response',
        async () => {
          const logger = createDebugLogger();
          const workdir = path.join(os.tmpdir(), `lody-e2e-${agent.agentType}-prompt`);
          fs.mkdirSync(workdir, { recursive: true });

          const textChunks: string[] = [];
          const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
            cliType: agent.cliType,
            agentType: agent.agentType,
            workdir,
            logger,
            terminalManager: noopTerminalManager,
            onUpdateMessage: (msg) => {
              const update = msg.update as Record<string, unknown>;
              if (
                update.sessionUpdate === 'agent_message_chunk' &&
                typeof update.content === 'object' &&
                update.content !== null &&
                (update.content as { type?: string }).type === 'text'
              ) {
                textChunks.push((update.content as { text: string }).text);
              }
            },
            onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          });
          processes.push(agentProcess);

          const response = await client.prompt(acpSessionId, [
            { type: 'text', text: 'Reply with only the single word "pong". Nothing else.' },
          ]);

          const collectedText = textChunks.join('');
          const responseText = extractTextFromAgentResponse(response);
          console.log(
            `\n=== ${agent.displayName} prompt response ===\n` +
              `responseText: ${responseText}\n` +
              `collectedText: ${collectedText}`
          );

          // Either the response or the streamed text should contain "pong"
          const combinedText = `${responseText ?? ''} ${collectedText}`.toLowerCase();
          expect(combinedText).toContain('pong');

          await shutdownLocalAcpAgent({
            agentProcess,
            client,
            acpSessionId,
            logger,
            sessionLabel: `e2e-${agent.agentType}`,
          });
        },
        120_000
      );

      it(
        'setSessionMode works',
        async () => {
          const logger = createDebugLogger();
          const workdir = path.join(os.tmpdir(), `lody-e2e-${agent.agentType}-mode`);
          fs.mkdirSync(workdir, { recursive: true });

          const { agentProcess, client, acpSessionId, sessionResponse } =
            await startLocalAcpAgent({
              cliType: agent.cliType,
              agentType: agent.agentType,
              workdir,
              logger,
              terminalManager: noopTerminalManager,
              onUpdateMessage: () => {},
              onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            });
          processes.push(agentProcess);

          // Try setting mode via configOptions first
          const modeOption = sessionResponse.configOptions?.find(
            (o) => (o as { category?: string }).category === 'mode'
          );
          const modes = sessionResponse.modes?.availableModes ?? [];

          if (modeOption && modeOption.type === 'select') {
            const selectOption = modeOption as Extract<SessionConfigOption, { type: 'select' }>;
            const firstValue = selectOption.options[0];
            if (firstValue && 'value' in firstValue) {
              console.log(
                `\n=== ${agent.displayName} setSessionConfigOption mode=${firstValue.value} ===`
              );
              const result = await client.setSessionConfigOption(
                acpSessionId,
                modeOption.id,
                firstValue.value
              );
              console.log(
                `setSessionConfigOption result: ${JSON.stringify(result?.map((o) => o.id))}`
              );
              // Should not throw
            }
          } else if (modes.length > 0) {
            const firstMode = modes[0];
            if (firstMode) {
              console.log(`\n=== ${agent.displayName} setSessionMode mode=${firstMode.id} ===`);
              await client.setSessionMode(acpSessionId, firstMode.id);
              console.log(`setSessionMode succeeded`);
            }
          } else {
            console.log(`\n=== ${agent.displayName}: No modes available, skipping mode test ===`);
          }

          await shutdownLocalAcpAgent({
            agentProcess,
            client,
            acpSessionId,
            logger,
            sessionLabel: `e2e-${agent.agentType}`,
          });
        },
        120_000
      );

      it(
        'setSessionModel works',
        async () => {
          const logger = createDebugLogger();
          const workdir = path.join(os.tmpdir(), `lody-e2e-${agent.agentType}-model`);
          fs.mkdirSync(workdir, { recursive: true });

          const { agentProcess, client, acpSessionId, sessionResponse } =
            await startLocalAcpAgent({
              cliType: agent.cliType,
              agentType: agent.agentType,
              workdir,
              logger,
              terminalManager: noopTerminalManager,
              onUpdateMessage: () => {},
              onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            });
          processes.push(agentProcess);

          const modelOption = sessionResponse.configOptions?.find(
            (o) => (o as { category?: string }).category === 'model'
          );
          const models = sessionResponse.models?.availableModels ?? [];

          if (modelOption && modelOption.type === 'select') {
            const selectOption = modelOption as Extract<SessionConfigOption, { type: 'select' }>;
            const firstValue = selectOption.options[0];
            if (firstValue && 'value' in firstValue) {
              console.log(
                `\n=== ${agent.displayName} setSessionConfigOption model=${firstValue.value} ===`
              );
              const result = await client.setSessionConfigOption(
                acpSessionId,
                modelOption.id,
                firstValue.value
              );
              console.log(
                `setSessionConfigOption result: ${JSON.stringify(result?.map((o) => o.id))}`
              );
            }
          } else if (models.length > 0) {
            const firstModel = models[0];
            if (firstModel) {
              console.log(
                `\n=== ${agent.displayName} unstable_setSessionModel model=${firstModel.modelId} ===`
              );
              await client.unstable_setSessionModel(acpSessionId, firstModel.modelId);
              console.log(`unstable_setSessionModel succeeded`);
            }
          } else {
            console.log(`\n=== ${agent.displayName}: No models available, skipping model test ===`);
          }

          await shutdownLocalAcpAgent({
            agentProcess,
            client,
            acpSessionId,
            logger,
            sessionLabel: `e2e-${agent.agentType}`,
          });
        },
        120_000
      );

      it(
        'loadSession / resumeSession works',
        async () => {
          const logger = createDebugLogger();
          const workdir = path.join(os.tmpdir(), `lody-e2e-${agent.agentType}-resume`);
          fs.mkdirSync(workdir, { recursive: true });

          // Start first session
          const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
            cliType: agent.cliType,
            agentType: agent.agentType,
            workdir,
            logger,
            terminalManager: noopTerminalManager,
            onUpdateMessage: () => {},
            onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          });
          processes.push(agentProcess);

          // Send a prompt to create session state
          await client.prompt(acpSessionId, [
            { type: 'text', text: 'Remember this word: "banana".' },
          ]);

          // Shutdown the first session
          await shutdownLocalAcpAgent({
            agentProcess,
            client,
            acpSessionId,
            logger,
            sessionLabel: `e2e-${agent.agentType}-resume-1`,
          });

          // Spawn a fresh ACP process and resume using the original acpSessionId
          const resumeProcess = spawnAcpProcess({
            cliType: agent.cliType,
            agentType: agent.agentType,
            workdir,
            env: process.env,
          });
          processes.push(resumeProcess);

          if (!resumeProcess.stdout || !resumeProcess.stdin) {
            throw new Error('Agent process stdio not available');
          }
          const output = createStdoutReadableStream(resumeProcess.stdout);
          const input = createStdinWritableStream(resumeProcess.stdin);
          const stream = ndJsonStream(input, output);

          const textChunks: string[] = [];
          const { client: resumedClient, acpSessionId: resumedSessionId } =
            await createAcpClient({
              stream,
              workdir,
              logger,
              terminalManager: noopTerminalManager,
              agentConfig: { cliType: agent.cliType, agentType: agent.agentType },
              resumeSessionId: acpSessionId,
              onUpdateMessage: (msg) => {
                const update = msg.update as Record<string, unknown>;
                if (
                  update.sessionUpdate === 'agent_message_chunk' &&
                  typeof update.content === 'object' &&
                  update.content !== null &&
                  (update.content as { type?: string }).type === 'text'
                ) {
                  textChunks.push((update.content as { text: string }).text);
                }
              },
              onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            });

          console.log(
            `\n=== ${agent.displayName} resume: resumed session (original=${acpSessionId}, resumed=${resumedSessionId}) ===`
          );
          expect(resumedSessionId).toBe(acpSessionId);

          // Ask about the remembered word to verify session context was restored
          await resumedClient.prompt(resumedSessionId, [
            { type: 'text', text: 'What word did I ask you to remember? Reply with just that word.' },
          ]);
          const collectedText = textChunks.join('').toLowerCase();
          console.log(`\n=== ${agent.displayName} resume response: ${collectedText} ===`);
          expect(collectedText).toContain('banana');

          await shutdownLocalAcpAgent({
            agentProcess: resumeProcess,
            client: resumedClient,
            acpSessionId: resumedSessionId,
            logger,
            sessionLabel: `e2e-${agent.agentType}-resume-2`,
          });
        },
        180_000
      );
    });
  }
});
