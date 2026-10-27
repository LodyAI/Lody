import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Effect } from 'effect';
import { z } from 'zod';
import { READ_ONLY_ABANDON_POLICY, runCommandOk } from '@lody/shared/node/process';
import {
  isNodeApiVersionSupported,
  isNodeSecurityVersionSupported,
} from '@/utils/node-runtime-version';

type NodeErrorCode = 'DSH_NODE_NOT_FOUND' | 'DSH_NODE_UNSUPPORTED' | 'DSH_NODE_EXEC_FAILED';

class DeepSeekNodeError extends Error {
  constructor(
    readonly code: NodeErrorCode,
    detail: string
  ) {
    super(
      `[${code}] ${detail} Install a supported Node.js with npm/npx from https://nodejs.org/en/download on the machine running this Agent, ensure node is on PATH, fully restart Lody/CLI, and retry.`
    );
    this.name = 'DeepSeekNodeError';
  }
}

export function resolveDeepSeekNodePath(
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string {
  const pathKey = Object.keys(env).find((key) =>
    platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
  );
  for (const entry of (env[pathKey ?? 'PATH'] ?? '').split(platform === 'win32' ? ';' : ':')) {
    const directory = entry.replace(/^"|"$/g, '');
    // Never execute a project-local node through an empty or relative PATH entry.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, platform === 'win32' ? 'node.exe' : 'node');
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        continue;
      throw new DeepSeekNodeError(
        'DSH_NODE_EXEC_FAILED',
        `Cannot inspect Node.js at ${candidate}: ${String(error)}`
      );
    }
  }
  throw new DeepSeekNodeError(
    'DSH_NODE_NOT_FOUND',
    'DeepSeek Harness requires Node.js, but node was not found on the target machine PATH.'
  );
}

const runtimeSchema = z.object({
  node: z.string(),
  napi: z.string().optional(),
  electron: z.string().optional(),
});

/** The caller owns execution/cancellation; the shared process Scope owns probe cleanup. */
export const prepareDeepSeekNodeEnvironment = Effect.fn('prepareDeepSeekNodeEnvironment')(
  function* (env: NodeJS.ProcessEnv) {
    const executable = yield* Effect.try({
      try: () => resolveDeepSeekNodePath(env),
      catch: (error) => error,
    });
    const childEnv = { ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const result = yield* runCommandOk({
      command: executable,
      args: [
        '-p',
        'JSON.stringify({node:process.versions.node,napi:process.versions.napi,electron:process.versions.electron})',
      ],
      // Keep an accidentally selected Electron shim in Node mode for the probe,
      // so rejecting it cannot launch a GUI. Standalone Node ignores this flag.
      env: { ...childEnv, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5_000,
      maxOutputBytes: 8_192,
      abandonPolicy: READ_ONLY_ABANDON_POLICY,
    }).pipe(
      Effect.mapError(
        (error) =>
          new DeepSeekNodeError(
            'DSH_NODE_EXEC_FAILED',
            `Could not run Node.js at ${executable}: ${error.message}`
          )
      )
    );
    const runtime = yield* Effect.try({
      try: () => runtimeSchema.parse(JSON.parse(result.stdout.toString('utf8'))),
      catch: () =>
        new DeepSeekNodeError(
          'DSH_NODE_EXEC_FAILED',
          `Node.js at ${executable} returned invalid runtime information.`
        ),
    });
    if (
      runtime.electron ||
      !isNodeApiVersionSupported(runtime.napi) ||
      !isNodeSecurityVersionSupported(runtime.node)
    ) {
      return yield* Effect.fail(
        new DeepSeekNodeError(
          'DSH_NODE_UNSUPPORTED',
          `DeepSeek Harness cannot use ${executable} (Node ${runtime.node}, Node-API ${runtime.napi ?? 'unknown'}${runtime.electron ? `, Electron ${runtime.electron}` : ''}). Use standalone Node.js v22.23.4+ (22.x), v24.22.1+ (24.x), or v26.12.1+ (26.x), with Node-API 10+.`
        )
      );
    }
    return { ...childEnv, LODY_DSH_NODE_EXECUTABLE: executable };
  }
);
