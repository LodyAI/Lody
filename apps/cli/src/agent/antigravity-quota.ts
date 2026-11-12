import type { AgentConfigCliType } from '@lody/shared';
import type { ClientSideConnection, SessionNotification } from '@agentclientprotocol/sdk';
import type { RateLimitsSnapshot } from 'acp-extension-core';
import { z } from 'zod';

export function isAntigravityRegistryAgent(agent: {
  cliType: AgentConfigCliType;
  agentType: string;
}): boolean {
  return agent.cliType === 'registry' && agent.agentType === 'antigravity-acp';
}

const remainingPercent = z.coerce.number().min(0).max(100);
const MAX_OUTPUT = 65_536;

function parseQuota(text: string): RateLimitsSnapshot {
  const windows: RateLimitsSnapshot['rateLimits'][number]['windows'] = [];
  let group: string | undefined;
  let inQuota = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === '### Quota Limits') {
      inQuota = true;
      continue;
    }
    if (!inQuota) continue;
    if (line.startsWith('### ')) break;
    const heading = /^- \*\*(.{1,160})\*\*$/.exec(line);
    if (heading) {
      group = heading[1];
      continue;
    }
    const row =
      /^\s+- \*\*(Weekly|Five Hour) Limit Remaining:\*\* ([\d.]+)% remaining(?: \(resets ([^)]+)\))?$/.exec(
        line
      );
    if (!row || !group) continue;
    const percent = remainingPercent.safeParse(row[2]);
    if (!percent.success) throw new Error('Invalid Antigravity quota percentage');
    // The official ACP output reports UTC. Never interpret an unzoned date locally.
    const reset = row[3]?.endsWith(' UTC') ? Date.parse(row[3]) / 1000 : NaN;
    windows.push({
      label: group,
      usedPercent: 100 - percent.data,
      windowDurationSeconds: row[1] === 'Weekly' ? 604_800 : 18_000,
      resetsAtEpochSeconds: Number.isFinite(reset) && reset > 0 ? reset : null,
    });
  }
  if (!windows.length) throw new Error('Antigravity quota is unavailable');
  return {
    rateLimits: [{ limitId: 'antigravity-acp', scope: { providerId: 'antigravity' }, windows }],
  };
}

/** One external ACP read; its caller owns the process, deadline and scratch directory. */
export function createAntigravityQuotaReader() {
  let sessionId: string | undefined;
  let advertised: { sessionId: string; names: string[] } | undefined;
  let resolveCommands = () => {};
  const commandsReady = new Promise<void>((resolve) => {
    resolveCommands = resolve;
  });
  let reading = false;
  let text = '';
  let oversized = false;
  return {
    update: async (params: SessionNotification) => {
      if (sessionId && params.sessionId !== sessionId) return;
      const update = params.update;
      if (update.sessionUpdate === 'available_commands_update') {
        advertised = {
          sessionId: params.sessionId,
          names: update.availableCommands.map((command) => command.name),
        };
        if (params.sessionId === sessionId) resolveCommands();
      }
      if (
        reading &&
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text'
      ) {
        if (text.length + update.content.text.length > MAX_OUTPUT) oversized = true;
        else if (!oversized) text += update.content.text;
      }
    },
    read: async (
      connection: ClientSideConnection,
      workdir: string
    ): Promise<RateLimitsSnapshot> => {
      const session = await connection.newSession({ cwd: workdir, mcpServers: [] });
      sessionId = session.sessionId;
      if (advertised?.sessionId === sessionId) resolveCommands();
      await Promise.race([
        commandsReady,
        connection.closed.then(() => {
          throw new Error('Antigravity closed before advertising commands');
        }),
      ]);
      // An unrecognized slash command can become a model prompt. Require the actual announcement.
      if (!advertised?.names.includes('usage')) throw new Error('Antigravity /usage unsupported');
      reading = true;
      const response = await connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: '/usage' }],
      });
      reading = false;
      if (response.stopReason !== 'end_turn')
        throw new Error('Antigravity quota query did not complete');
      if (oversized) throw new Error('Antigravity quota output is too large');
      return parseQuota(text);
    },
  };
}
