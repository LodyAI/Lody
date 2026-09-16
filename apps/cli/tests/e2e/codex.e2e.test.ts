import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import * as fs from 'fs';

import { startLocalAcpAgent } from '../../src/agent/acp-runner';
import { extractTextFromAgentResponse } from '../../src/agent/response-utils';
import type { Logger } from '../../src/utils/logger';
import type { TerminalManager } from '../../src/session/terminal-manager';

const createSilentLogger = (): Logger => ({
  info: () => { },
  warn: () => { },
  error: () => { },
  success: () => { },
  debug: () => { },
  trace: () => { },
  setLevel: () => { },
  child: () => createSilentLogger(),
  close: async () => { },
});


const noopTerminalManager: TerminalManager = {
  createTerminal: async () => {
    throw new Error('Terminal not supported in E2E test');
  },
  terminalOutput: async () => {
    throw new Error('Terminal not supported in E2E test');
  },
  releaseTerminal: async () => { },
  waitForTerminalExit: async () => ({ exitCode: null }),
  killTerminal: async () => { },
};

const runE2E = process.env.LODY_E2E === '1';
const e2eDescribe = runE2E ? describe : describe.skip;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

e2eDescribe('codex ACP e2e', () => {
  it(
    'runs codex agent and returns a response',
    async () => {
      const logger = createSilentLogger();
      const workdir = path.join(os.tmpdir(), 'lody-codex-e2e');
      fs.mkdirSync(workdir, { recursive: true });

      let collectedText = '';
      const { agentProcess, client, acpSessionId } = await startLocalAcpAgent({
        cliType: 'codex',
        workdir,
        logger,
        terminalManager: noopTerminalManager,
        sandbox: true,
        extraArgs: [
          '-c',
          'model="gpt-5.1-codex-mini"',
          '-c',
          'model_reasoning_effort="low"',
        ],
        onUpdateMessage: (msg) => {
          const update = msg.update;
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content &&
            update.content.type === 'text'
          ) {
            collectedText += update.content.text;
          }
          void update;
        },
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });

      try {
        const response = await client?.prompt(
          acpSessionId,
          [
            {
              type: 'text',
              text: 'Reply with the single word "pong".',
            },
          ],
        );
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
      } finally {
        if (!agentProcess.killed) {
          try {
            agentProcess.kill('SIGTERM');
          } catch {
            // ignore
          }
        }
      }
    },
    60000
  );
});
