/**
 * Fails fast, with a readable message, on the two runtimes where better-sqlite3 >=13
 * cannot work. Both are narrowings versus better-sqlite3 12, and neither one otherwise
 * surfaces as anything resembling "unsupported runtime".
 *
 * 1. Node-API floor. 13.x is built with `NAPI_VERSION=10` (its binding.gyp), and
 *    Node-API 10 landed in Node v22.14.0 / v23.6.0. Loading the binding on anything
 *    older **segfaults** — no exception, no output, exit code 139. better-sqlite3 12's
 *    per-ABI prebuilds shipped one `node-v127` build covering all of Node 22.x.
 *
 * 2. 32-bit ARM. 13.x resolves `prebuilds/<platform>-<arch>.node` and ships x64/arm64
 *    only; since 13.0.2 dropped the install script there is no source-build fallback
 *    either. 12.x published `linux-arm` and `linuxmusl-arm`, so armv7 used to work.
 *    Without this check the failure is `Cannot find module
 *    '.../better-sqlite3/build/Release/better_sqlite3.node'`, which reads as a corrupt
 *    install and invites endless reinstall attempts.
 *
 * `engines` covers neither case: npm only warns on a mismatch unless `engine-strict`
 * is set, and npx does not enforce it at all.
 *
 * Node-API is read from `process.versions.napi` rather than the version string because
 * that is what the addon loader actually gates on, and it stays correct under Electron
 * (Electron 39 reports napi 10 on Node 22.22).
 */
export const REQUIRED_NODE_API_VERSION = 10;

/** Architectures better-sqlite3 ships a prebuilt binding for (its lib/binding.js). */
export const SUPPORTED_ARCHS = ['x64', 'arm64'] as const;

/** Exported for tests: `undefined`/unparsable napi fails closed. */
export function isNodeApiVersionSupported(napi: string | undefined): boolean {
  const parsed = Number.parseInt(napi ?? '', 10);
  return Number.isFinite(parsed) && parsed >= REQUIRED_NODE_API_VERSION;
}

export function isArchSupported(arch: string): boolean {
  return (SUPPORTED_ARCHS as readonly string[]).includes(arch);
}

/** The reason this runtime cannot load the binding, or `undefined` if it can. */
export function describeUnsupportedRuntime(runtime: {
  napi: string | undefined;
  arch: string;
}): string | undefined {
  if (!isArchSupported(runtime.arch)) {
    return (
      `Lody does not support the ${runtime.arch} architecture: its SQLite engine ships ` +
      `prebuilt binaries for ${SUPPORTED_ARCHS.join(' and ')} only, and cannot be built ` +
      `from source.\nOn 32-bit ARM, a 64-bit OS (arm64) is the supported path.`
    );
  }
  if (!isNodeApiVersionSupported(runtime.napi)) {
    return (
      `Lody needs Node-API ${REQUIRED_NODE_API_VERSION}, which means Node.js v22.14.0+, ` +
      `v23.6.0+, or a later release (you are on ${process.version}, ` +
      `Node-API ${runtime.napi ?? 'unknown'}).\n` +
      `Its SQLite binding would crash the process instead of failing cleanly here.\n` +
      `Upgrade Node, then re-run: npx lody@latest`
    );
  }
  return undefined;
}

export function assertSqliteRuntimeSupported(): void {
  const problem = describeUnsupportedRuntime({
    napi: process.versions.napi,
    arch: process.arch,
  });
  if (problem === undefined) {
    return;
  }
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

// Run on import, not from the entry's module body: ES module imports are hoisted and
// evaluated before any statement in the importer, so a call placed "first" in index.ts
// would still run after every other import had already been evaluated. Importing this
// module first is the only way to actually get in front of them.
assertSqliteRuntimeSupported();
