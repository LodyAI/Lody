import type { ClientSideConnection, SessionNotification } from '@agentclientprotocol/sdk';
import type { LodyRateLimitsCapability, RateLimitsSnapshot } from 'acp-extension-core';
import { z } from 'zod';

export function isAntigravityRegistryAgent(agent: { cliType: string; agentType: string }): boolean {
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

const QUOTA_SESSION_DELETE_TIMEOUT_MS = 3_000;

/** Best effort: the quota session is scratch, and a failed delete must not discard the reading. */
async function deleteQuotaSession(connection: ClientSideConnection, sessionId: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    connection.deleteSession({ sessionId }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUOTA_SESSION_DELETE_TIMEOUT_MS);
    }),
  ])
    .catch(() => {})
    .finally(() => clearTimeout(timer));
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
      workdir: string,
      options: { deleteSession: boolean }
    ): Promise<RateLimitsSnapshot> => {
      const session = await connection.newSession({ cwd: workdir, mcpServers: [] });
      sessionId = session.sessionId;
      try {
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
      } finally {
        if (options.deleteSession) await deleteQuotaSession(connection, session.sessionId);
      }
    },
  };
}

/** agy print mode handles this command without starting a model turn. */
export function parseAntigravityCliQuota(value: unknown): RateLimitsSnapshot {
  const bucket = z.object({
    id: z.string().min(1).max(160),
    window: z.enum(['weekly', '5h']),
    remaining_fraction: z.number().min(0).max(1),
    reset_time: z.iso.datetime({ offset: true }).optional(),
  });
  const result = z
    .object({
      status: z.literal('SUCCESS'),
      num_turns: z.literal(0),
      command: z.object({
        name: z.literal('usage'),
        data: z.object({
          groups: z
            .array(
              z.object({
                name: z.string().min(1).max(160),
                buckets: z.array(bucket).min(1).max(16),
              })
            )
            .min(1)
            .max(32),
        }),
      }),
    })
    .parse(value);
  const windows = result.command.data.groups.flatMap((group) =>
    group.buckets.map((b) => ({
      label: group.name,
      usedPercent: (1 - b.remaining_fraction) * 100,
      windowDurationSeconds: b.window === 'weekly' ? 604_800 : 18_000,
      resetsAtEpochSeconds: b.reset_time ? Date.parse(b.reset_time) / 1000 : null,
    }))
  );
  return {
    rateLimits: [{ limitId: 'antigravity', scope: { providerId: 'antigravity' }, windows }],
  };
}

export function isAntigravityBuiltinAgent(agent: { cliType: string; agentType: string }): boolean {
  return agent.cliType === 'builtin' && agent.agentType === 'antigravity';
}

/** Lody owns these query readers even when the official runtime advertises no Core extension. */
export function getAntigravityQuotaCapability(agent?: {
  cliType: string;
  agentType: string;
}): LodyRateLimitsCapability | undefined {
  return agent && (isAntigravityBuiltinAgent(agent) || isAntigravityRegistryAgent(agent))
    ? { version: 1, query: true }
    : undefined;
}
