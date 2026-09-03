/**
 * Capture a real local ACP history replay for
 * `pnpm --filter @lody/history-import bench -- --notifications=<file>`.
 *
 * This is the IO half of the import benchmark: it spawns the provider's ACP
 * adapter exactly like `LocalProjectHistorySyncService` does, replays one
 * session, and writes the collected notifications to disk. It also reports how
 * long listing and replaying took, which is the part of import cost that no pure
 * benchmark can measure.
 *
 * Captured output contains real conversation content: write it outside the
 * repository and never commit it.
 *
 *   pnpm --filter lody exec tsx scripts/dump-history-import-fixture.ts \
 *     --root <local project path> [--agent claude|codex] [--session <acpSessionId>] \
 *     --out /tmp/replay.json
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { ACPSessionId, LocalProjectHistoryProvider } from '@lody/shared';

import { configureManagedAgentRuntimeManager } from '@/agent/managed-agent-runtime';
import {
  listHistorySessionsForLocalProject,
  loadHistorySessionReplay,
} from '@/lib/history-session-catalog-client';
import { resolveRuntimeArtifactsBaseUrl } from '@lody/platform';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readFlag = (name: string): string | null => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1) return argv[index + 1] ?? null;
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
};

const logger = {
  debug: (message: string) => {
    if (process.env.DUMP_DEBUG) console.error(message);
  },
  info: (message: string) => console.error(message),
  warn: (message: string) => console.error(message),
  error: (message: string) => console.error(message),
} as never;

async function main(): Promise<void> {
  const rootPath = readFlag('root');
  const outPath = readFlag('out');
  if (!rootPath || !outPath) {
    console.error(
      'Usage: tsx scripts/dump-history-import-fixture.ts --root <path> --out <file.json> ' +
        '[--agent claude|codex] [--session <acpSessionId>]'
    );
    process.exitCode = 1;
    return;
  }

  // Builtin adapters launch through the managed runtime, which `lody start`
  // normally configures during CloudPort assembly.
  configureManagedAgentRuntimeManager({
    runtimeBaseUrl: resolveRuntimeArtifactsBaseUrl(process.env.LODY_RUNTIME_BASE_URL),
  });

  // `resolveCliAdapterEntry` looks for `<adapter>.js` next to `process.argv[1]`,
  // which under `tsx scripts/...` is this file. Point it at a built bundle
  // (`pnpm --filter lody dev:build` writes `dist-dev/`) so the adapter resolves.
  const adapterDir = path.resolve(readFlag('adapter-dir') ?? path.join(rootDir, 'dist-dev'));
  if (!existsSync(path.join(adapterDir, 'claude-acp.js'))) {
    throw new Error(
      `No built ACP adapters in ${adapterDir}; run \`pnpm --filter lody dev:build\` first ` +
        'or pass --adapter-dir.'
    );
  }
  process.argv[1] = path.join(adapterDir, 'index.js');

  const agentType = readFlag('agent') ?? 'claude';
  const provider = { cliType: 'builtin', agentType } as LocalProjectHistoryProvider;

  const listStart = performance.now();
  const catalog = await listHistorySessionsForLocalProject({ provider, rootPath, logger });
  const listMs = performance.now() - listStart;

  const requested = readFlag('session');
  // Default to the most recently touched session: the longest transcript in a
  // project is usually its active one.
  const target =
    (requested
      ? catalog.sessions.find((session) => session.sessionId === requested)
      : [...catalog.sessions].sort(
          (left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? '') || 0
        )[0]) ?? null;
  if (!target) {
    throw new Error(`No matching session in ${rootPath} (listed ${catalog.sessions.length})`);
  }

  const replayStart = performance.now();
  const notifications = await loadHistorySessionReplay({
    provider,
    rootPath,
    acpSessionId: target.sessionId as unknown as ACPSessionId,
    logger,
  });
  const replayMs = performance.now() - replayStart;

  await writeFile(outPath, JSON.stringify(notifications), 'utf8');
  console.error(
    JSON.stringify(
      {
        agentType,
        acpSessionId: target.sessionId,
        listedSessions: catalog.sessions.length,
        notifications: notifications.length,
        listMs: Number(listMs.toFixed(0)),
        replayMs: Number(replayMs.toFixed(0)),
        out: outPath,
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
