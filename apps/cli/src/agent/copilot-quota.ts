import type { ChildProcess } from 'node:child_process';
import type { LodyRateLimitsCapability, RateLimitsSnapshot } from 'acp-extension-core';
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

const sdkMessage = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number().int(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).optional(),
});

/** Two sequential SDK requests only; the startup owner terminates and awaits the tree. */
export async function readCopilotQuota(child: ChildProcess, startupAbort: Promise<never>) {
  const { stdout, stdin, stderr } = child;
  if (!stdout || !stdin) throw new Error('Copilot quota stdio unavailable');
  let dispose = () => {};
  const query = new Promise<RateLimitsSnapshot>((resolve, reject) => {
    let bytes = 0;
    let buffer = Buffer.alloc(0);
    let expectedId = 1;
    const countOutput = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= 65_536) return true;
      reject(new Error('Copilot quota output is too large'));
      return false;
    };
    const write = (id: number, method: string) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });
      stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, (error) => {
        if (error) reject(new Error('Copilot quota input failed'));
      });
    };
    const onData = (chunk: Buffer) => {
      if (!countOutput(chunk)) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (true) {
          const boundary = buffer.indexOf('\r\n\r\n');
          if (boundary < 0) return;
          const lengths = buffer
            .subarray(0, boundary)
            .toString('ascii')
            .split('\r\n')
            .filter((line) => /^content-length:/i.test(line));
          const match = /^content-length:[ \t]*(\d+)[ \t]*$/i.exec(lengths[0] ?? '');
          const length = Number(match?.[1]);
          if (
            lengths.length !== 1 ||
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > 65_536
          )
            throw new Error('Invalid Copilot quota frame length');
          if (buffer.length < boundary + 4 + length) return;
          const message = sdkMessage.parse(
            JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString('utf8'))
          );
          buffer = buffer.subarray(boundary + 4 + length);
          if (message.method !== undefined) {
            if (message.id !== undefined)
              throw new Error('Unexpected Copilot quota server request');
            continue;
          }
          if (message.id !== expectedId) continue;
          if (message.error) throw new Error('Copilot quota RPC failed');
          if (expectedId === 1) {
            if (!z.object({ protocolVersion: z.literal(3) }).safeParse(message.result).success)
              throw new Error('Unsupported Copilot quota protocol version');
            expectedId = 2;
            write(2, 'account.getQuota');
          } else {
            resolve(parseCopilotQuota(message.result));
            return;
          }
        }
      } catch {
        reject(new Error('Copilot quota response is unavailable or invalid'));
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      countOutput(chunk);
    };
    const onClose = () => reject(new Error('Copilot quota connection closed'));
    const onError = () => reject(new Error('Copilot quota protocol failed'));
    const timer = setTimeout(() => reject(new Error('Copilot quota query timed out')), 20_000);
    stdout.on('data', onData);
    stderr?.on('data', onStderr);
    stdout.on('end', onClose);
    stdout.on('close', onClose);
    stdout.on('error', onError);
    stdin.on('error', onError);
    dispose = () => {
      clearTimeout(timer);
      stdout.off('data', onData);
      stderr?.off('data', onStderr);
      stdout.off('end', onClose);
      stdout.off('close', onClose);
      stdout.off('error', onError);
      stdin.off('error', onError);
    };
    write(1, 'ping');
  });
  try {
    return await Promise.race([query, startupAbort]);
  } finally {
    dispose();
  }
}
