import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  describeUnsupportedRuntime,
  isArchSupported,
  isNodeApiVersionSupported,
  REQUIRED_NODE_API_VERSION,
  SUPPORTED_ARCHS,
} from '../src/utils/sqlite-runtime-support';
import {
  assertNodeRuntimeSupported,
  describeUnsupportedNodeRuntime,
  isNodeApiVersionSupported as isWorkspaceNodeApiVersionSupported,
} from '../../../scripts/check-node-runtime.mjs';

const require = createRequire(import.meta.url);
const sqliteDir = dirname(require.resolve('better-sqlite3/package.json'));
const supportedNodeEngineRange = '>=22.14.0 <23 || >=23.6.0';
const supportedPnpmVersion = '10.20.0';

describe('SQLite runtime support guard', () => {
  it('rejects every runtime below the Node-API version the binding is built against', () => {
    // Node-API 9 is Node 22.0-22.13 — supported by better-sqlite3 12, segfaults on 13.
    expect(isNodeApiVersionSupported('9')).toBe(false);
    expect(isNodeApiVersionSupported(undefined)).toBe(false);
    expect(isNodeApiVersionSupported('')).toBe(false);
    expect(isNodeApiVersionSupported('not-a-number')).toBe(false);

    expect(isNodeApiVersionSupported('10')).toBe(true);
    expect(isNodeApiVersionSupported('11')).toBe(true);
  });

  it('rejects architectures that have no prebuilt binding and cannot build one', () => {
    // armv7 had `linux-arm`/`linuxmusl-arm` prebuilds under 12.x and has none under 13.
    expect(isArchSupported('arm')).toBe(false);
    expect(isArchSupported('ia32')).toBe(false);
    expect(isArchSupported('x64')).toBe(true);
    expect(isArchSupported('arm64')).toBe(true);
  });

  it('reports the architecture first, since upgrading Node cannot fix armv7', () => {
    const message = describeUnsupportedRuntime({ napi: '9', arch: 'arm' });
    expect(message).toContain('arm');
    expect(message).not.toContain('Upgrade Node');

    expect(describeUnsupportedRuntime({ napi: '9', arch: 'x64' })).toContain('v22.14.0');
    expect(describeUnsupportedRuntime({ napi: '10', arch: 'x64' })).toBeUndefined();
  });

  it('matches the NAPI_VERSION better-sqlite3 is actually compiled with', () => {
    // If better-sqlite3 raises NAPI_VERSION, the runtime floor moves with it and this
    // guard would silently let a segfaulting runtime through.
    const declared = /NAPI_VERSION=(\d+)/.exec(
      readFileSync(`${sqliteDir}/binding.gyp`, 'utf8')
    )?.[1];
    expect(declared, 'NAPI_VERSION not found in better-sqlite3/binding.gyp').toBeDefined();
    expect(Number(declared)).toBe(REQUIRED_NODE_API_VERSION);
  });

  it('matches the architectures better-sqlite3 actually ships binaries for', () => {
    const shipped = new Set(
      readdirSync(`${sqliteDir}/prebuilds`).map((file) => file.replace(/\.node$/, '').split('-')[1])
    );
    expect([...shipped].sort()).toEqual([...SUPPORTED_ARCHS].sort());
  });

  it('declares an engines range that cannot admit an unsupported runtime', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { engines?: { node?: string } };
    // Node-API 10 landed in 22.14.0 and 23.6.0; anything looser lets npm install
    // onto a runtime that crashes. engines is only a warning, hence the guards.
    expect(packageJson.engines?.node).toBe(supportedNodeEngineRange);
  });

  it('keeps the workspace runtime declarations aligned with the CLI', () => {
    const workspacePackageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    ) as {
      engines?: { node?: string; pnpm?: string };
      devEngines?: {
        runtime?: { name?: string; version?: string; onFail?: string };
      };
      packageManager?: string;
      scripts?: { preinstall?: string };
    };
    const cliPackageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { engines?: { node?: string } };
    const turnDiffPackageJson = JSON.parse(
      readFileSync(
        new URL('../../../packages/turn-diff-store/package.json', import.meta.url),
        'utf8'
      )
    ) as { engines?: { node?: string } };

    expect(workspacePackageJson.engines?.node).toBe(cliPackageJson.engines?.node);
    expect(turnDiffPackageJson.engines?.node).toBe(cliPackageJson.engines?.node);
    expect(workspacePackageJson.devEngines?.runtime).toEqual({
      name: 'node',
      version: cliPackageJson.engines?.node,
      onFail: 'error',
    });
    expect(workspacePackageJson.engines?.pnpm).toBe(supportedPnpmVersion);
    expect(workspacePackageJson.packageManager).toMatch(
      new RegExp(`^pnpm@${supportedPnpmVersion.replaceAll('.', '\\.')}(?:\\+|$)`)
    );
    expect(workspacePackageJson.scripts?.preinstall).toBe(
      'node scripts/check-node-runtime.mjs && node scripts/guard-nested-workspace-install.mjs'
    );
  });

  it('hard-fails workspace installs below Node-API 10', () => {
    expect(isWorkspaceNodeApiVersionSupported('9')).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported(undefined)).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported('')).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported('10suffix')).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported('10')).toBe(true);
    expect(
      describeUnsupportedNodeRuntime({ nodeVersion: 'v23.5.0', nodeApiVersion: '9' })
    ).toContain('Node-API 10');
    expect(
      describeUnsupportedNodeRuntime({ nodeVersion: 'v23.6.0', nodeApiVersion: '10' })
    ).toBeUndefined();

    const originalExitCode = process.exitCode;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      assertNodeRuntimeSupported({ nodeVersion: 'v23.5.0', nodeApiVersion: '9' });
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Node-API 10'));
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
    }
  });

  it('enforces the runtime check only when the preinstall script is executed', () => {
    const scriptPath = fileURLToPath(
      new URL('../../../scripts/check-node-runtime.mjs', import.meta.url)
    );
    const supported = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    expect(supported.status).toBe(0);
    expect(supported.stderr).toBe('');

    const spoofNodeApi9 = `data:text/javascript,${encodeURIComponent(
      "Object.defineProperty(process.versions, 'napi', { value: '9' });"
    )}`;
    const unsupported = spawnSync(process.execPath, ['--import', spoofNodeApi9, scriptPath], {
      encoding: 'utf8',
    });
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain('Node-API 10');

    const importOnly = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `Object.defineProperty(process.versions, 'napi', { value: '9' }); await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`,
      ],
      { encoding: 'utf8' }
    );
    expect(importOnly.status).toBe(0);
    expect(importOnly.stderr).toBe('');
  });
});
