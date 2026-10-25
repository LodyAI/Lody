import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  describeUnsupportedRuntime,
  isArchSupported,
  isNodeSecurityVersionSupported,
  isNodeApiVersionSupported,
  REQUIRED_NODE_API_VERSION,
  SUPPORTED_ARCHS,
} from '../src/utils/sqlite-runtime-support';
import {
  assertNodeRuntimeSupported,
  describeUnsupportedNodeRuntime,
  isNodeApiVersionSupported as isWorkspaceNodeApiVersionSupported,
  isNodeSecurityVersionSupported as isWorkspaceNodeSecurityVersionSupported,
} from '../../../scripts/check-node-runtime.mjs';

const require = createRequire(import.meta.url);
const sqliteDir = dirname(require.resolve('better-sqlite3/package.json'));
const supportedNodeEngineRange = '>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27';

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

    expect(describeUnsupportedRuntime({ napi: '9', arch: 'x64' })).toContain('Node-API 10');
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
      engines?: { node?: string };
      devEngines?: {
        runtime?: { name?: string; version?: string; onFail?: string };
      };
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
    expect(workspacePackageJson.scripts?.preinstall).toBe(
      'node scripts/check-node-runtime.mjs && node scripts/guard-nested-workspace-install.mjs'
    );
  });

  it.each([
    ['22.23.3', false],
    ['22.23.4', true],
    ['22.24.0', true],
    ['23.6.0', false],
    ['24.21.0', false],
    ['24.22.0', false],
    ['24.22.1', true],
    ['25.0.0', false],
    ['26.12.0', false],
    ['26.12.1', true],
    ['26.13.0', true],
    ['27.0.0', false],
    ['24.22.1-rc.1', false],
    ['garbage', false],
  ])('enforces the security boundary for Node %s', (nodeVersion, supported) => {
    expect(isNodeSecurityVersionSupported(nodeVersion)).toBe(supported);
    expect(isWorkspaceNodeSecurityVersionSupported(nodeVersion)).toBe(supported);
    const runtime = { napi: '10', arch: 'x64', nodeVersion };
    expect(describeUnsupportedRuntime(runtime) === undefined).toBe(supported);
    expect(
      describeUnsupportedNodeRuntime({ nodeVersion, nodeApiVersion: '10' }) === undefined
    ).toBe(supported);
  });

  it('keeps Electron separate from standalone Node security floors, retaining native guards', () => {
    const runtime = {
      napi: '10',
      arch: 'arm64',
      nodeVersion: '24.21.0',
      electronVersion: '44.7.0',
    };
    expect(describeUnsupportedRuntime(runtime)).toBeUndefined();
    expect(describeUnsupportedRuntime({ ...runtime, napi: '9' })).toContain('Node-API 10');
    expect(describeUnsupportedRuntime({ ...runtime, arch: 'arm' })).toContain('architecture');
  });

  it('hard-fails workspace installs below Node-API 10', () => {
    expect(isWorkspaceNodeApiVersionSupported('9')).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported(undefined)).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported('')).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported('10suffix')).toBe(false);
    expect(isWorkspaceNodeApiVersionSupported('10')).toBe(true);
    const unsupportedDescription = describeUnsupportedNodeRuntime({
      nodeVersion: 'v23.5.0',
      nodeApiVersion: '9',
    });
    expect(unsupportedDescription).toContain('Node-API 10');
    expect(unsupportedDescription).toContain('v22.23.4+');
    expect(
      describeUnsupportedNodeRuntime({ nodeVersion: 'v24.22.1', nodeApiVersion: '10' })
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

    const spoofVulnerableNode = `data:text/javascript,${encodeURIComponent(
      "Object.defineProperty(process, 'version', { value: 'v24.22.0' });"
    )}`;
    const vulnerable = spawnSync(process.execPath, ['--import', spoofVulnerableNode, scriptPath], {
      encoding: 'utf8',
    });
    expect(vulnerable.status).toBe(1);
    expect(vulnerable.stderr).toContain('v24.22.1+');

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
