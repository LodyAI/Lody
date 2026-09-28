import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import * as fs from 'fs';

import { startLocalAcpAgent } from '../../src/agent/acp-runner';
import type { Logger } from '../../src/utils/logger';
import type { TerminalManager } from '../../src/session/terminal-manager';
import { SUPPORTED_CLI_TYPES, type CliType } from '@lody/shared';
import { ChildProcess } from 'child_process';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
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

const runE2E = process.env.LODY_E2E === '1';
const e2eDescribe = runE2E ? describe : describe.skip;

const cliTypes: CliType[] = [...SUPPORTED_CLI_TYPES];

const ensureProcessStopped = (agentProcess: ChildProcess) => {
  if (!agentProcess.killed) {
    try {
      agentProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
};

e2eDescribe('acp configs e2e', () => {
  it('returns the expected builtin config options', async () => {
    const logger = createSilentLogger();

    for (const cliType of cliTypes) {
      const workdir = path.join(os.tmpdir(), `lody-acp-configs-${cliType}`);
      fs.mkdirSync(workdir, { recursive: true });

      const { agentProcess, sessionResponse } = await startLocalAcpAgent({
        cliType,
        workdir,
        logger,
        terminalManager: noopTerminalManager,
        sandbox: true,
        onUpdateMessage: () => {},
        onRequestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });

      try {
        const agentConfigOptions = sessionResponse.configOptions ?? [];

        // Kimi models are account-specific and intentionally come only from
        // the user's runtime config. Claude and Codex ship a model selector.
        const configIds = agentConfigOptions.map((opt) => opt.id);
        expect(configIds).toContain('mode');
        if (cliType !== 'kimi') {
          expect(configIds).toContain('model');
        }

        // Each config option should have at least one selectable value
        for (const opt of agentConfigOptions) {
          expect(opt.id).toBeTruthy();
          const values = (opt.values ?? []).flatMap((v) =>
            'values' in v ? v.values.map((sv: { value: string }) => sv.value) : [v.value]
          );
          expect(values.length).toBeGreaterThan(0);
        }
      } finally {
        ensureProcessStopped(agentProcess);
      }
    }
  });
});
