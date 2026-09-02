export const REQUIRED_NODE_API_VERSION = 10;
export const SUPPORTED_SQLITE_ARCHS = ['x64', 'arm64'] as const;

export interface TurnDiffSqliteRuntime {
  readonly napi: string | undefined;
  readonly arch: string;
  readonly nodeVersion: string;
}

export function describeUnsupportedTurnDiffSqliteRuntime(
  runtime: TurnDiffSqliteRuntime
): string | undefined {
  if (!(SUPPORTED_SQLITE_ARCHS as readonly string[]).includes(runtime.arch)) {
    return (
      `@lody/turn-diff-store does not support the ${runtime.arch} architecture: ` +
      `better-sqlite3 ships prebuilt binaries for ${SUPPORTED_SQLITE_ARCHS.join(' and ')} only.`
    );
  }

  const napi = Number.parseInt(runtime.napi ?? '', 10);
  if (!Number.isFinite(napi) || napi < REQUIRED_NODE_API_VERSION) {
    return (
      `@lody/turn-diff-store needs Node-API ${REQUIRED_NODE_API_VERSION} ` +
      `(Node.js 22.14.0+, 23.6.0+, or a later release); received ${runtime.nodeVersion} with ` +
      `Node-API ${runtime.napi ?? 'unknown'}.`
    );
  }
  return undefined;
}

export function assertTurnDiffSqliteRuntimeSupported(): void {
  const problem = describeUnsupportedTurnDiffSqliteRuntime({
    napi: process.versions.napi,
    arch: process.arch,
    nodeVersion: process.version,
  });
  if (problem !== undefined) throw new Error(problem);
}

// This side-effect import must evaluate before better-sqlite3. Older Node-API
// runtimes can terminate the process while loading that native addon.
assertTurnDiffSqliteRuntimeSupported();
