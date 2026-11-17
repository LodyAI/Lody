import type { ChildProcess } from 'node:child_process';
import type { LodyRateLimitsCapability, RateLimitsSnapshot } from 'acp-extension-core';
import { createMessageConnection } from 'vscode-jsonrpc/node';
import { z } from 'zod';

export function isCopilotQuotaAgent(agent: { cliType: string; agentType: string }): boolean {
  return agent.cliType === 'registry' && agent.agentType === 'github-copilot-cli';
}

/** Lody compatibility reader, not a capability advertised by upstream ACP. */
export function getCopilotQuotaCapability(agent?: {
  cliType: string;
  agentType: string;
}): LodyRateLimitsCapability | undefined {
  return agent && isCopilotQuotaAgent(agent) ? { version: 1, query: true } : undefined;
}

export function parseCopilotQuota(value: unknown): RateLimitsSnapshot {
  const result = z
    .object({
      quotaSnapshots: z.object({
        premium_interactions: z.object({
          isUnlimitedEntitlement: z.literal(false),
          remainingPercentage: z.number().min(0).max(100),
        }),
      }),
    })
    .safeParse(value);
  if (!result.success) throw new Error('Copilot subscription quota is unavailable');
  return {
    rateLimits: [
      {
        limitId: 'github-copilot-cli',
        scope: { providerId: 'github-copilot' },
        windows: [
          {
            label: 'Copilot subscription',
            usedPercent: 100 - result.data.quotaSnapshots.premium_interactions.remainingPercentage,
            windowDurationSeconds: null,
            resetsAtEpochSeconds: null,
          },
        ],
      },
    ],
  };
}

/** Keep the resolved launcher/package prefix and every account-selecting argument. */
export function copilotQuotaArgs(args: readonly string[]): string[] {
  const mode = args.indexOf('--acp');
  if (mode < 0 || args.lastIndexOf('--acp') !== mode)
    throw new Error('Unsupported Copilot quota launch mode');
  return [
    ...args.slice(0, mode),
    '--headless',
    '--stdio',
    ...args.slice(mode + 1),
    '--no-auto-update',
    '--disable-builtin-mcps',
    '--disable-client-telemetry',
    '--log-level',
    'error',
  ];
}

/** External SDK-mode JSON-RPC boundary. The ACP startup owner terminates and awaits the tree. */
export async function readCopilotQuota(child: ChildProcess, startupAbort: Promise<never>) {
  if (!child.stdout || !child.stdin) throw new Error('Copilot quota stdio unavailable');
  const connection = createMessageConnection(child.stdout, child.stdin);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bytes = 0;
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const countOutput = (chunk: Buffer | string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65_536) rejectFailure(new Error('Copilot quota output is too large'));
  };
  child.stdout.on('data', countOutput);
  child.stderr?.on('data', countOutput);
  const closed = connection.onClose(() =>
    rejectFailure(new Error('Copilot quota connection closed'))
  );
  const errored = connection.onError(() =>
    rejectFailure(new Error('Copilot quota protocol failed'))
  );
  connection.listen();
  try {
    timer = setTimeout(() => rejectFailure(new Error('Copilot quota query timed out')), 20_000);
    const query = async () => {
      const ping = z
        .object({ protocolVersion: z.literal(3) })
        .safeParse(await connection.sendRequest('ping', {}));
      if (!ping.success) throw new Error('Unsupported Copilot quota protocol version');
      return parseCopilotQuota(await connection.sendRequest('account.getQuota', {}));
    };
    return await Promise.race([query(), failure, startupAbort]);
  } finally {
    clearTimeout(timer);
    child.stdout.off('data', countOutput);
    child.stderr?.off('data', countOutput);
    closed.dispose();
    errored.dispose();
    connection.dispose();
  }
}
