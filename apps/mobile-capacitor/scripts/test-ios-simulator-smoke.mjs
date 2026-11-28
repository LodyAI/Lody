#!/usr/bin/env node
/**
 * iOS Simulator cold-startup smoke test for @lody/mobile-capacitor.
 * Builds the real Capacitor iOS App target for iphonesimulator, injects a
 * scratch-only fetch/error telemetry probe into a copy of App.app, boots an
 * ephemeral iOS Simulator, launches ai.lody.mobile, and asserts that native
 * boot + Better Auth session probe converge cleanly to /login with zero
 * uncaught errors or unhandled promise rejections.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  SMOKE_REVOKED_SESSION_TOKEN,
  buildPlaceholderBuildEnv,
  buildRevokedSessionSeed,
  buildSmokeProbeScript,
  collectRedirectOrigins,
  injectSmokeProbeHtml,
  parseSmokeCliArgs,
  selectIosSimulatorTarget,
  startSmokeStubServer,
} from './native-startup-smoke-lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, '..');
const IOS_APP_DIR = join(APP_DIR, 'ios', 'App');
const BUNDLE_ID = 'ai.lody.mobile';
const SIMCTL_LIMIT = { timeout: 180_000, killSignal: 'SIGKILL' };
const CLEANUP_OPTIONS = { ...SIMCTL_LIMIT, timeout: 30_000, stdio: 'ignore' };

function runInherited(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function runCapture(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

const execFileAsync = promisify(execFile);

async function launchApp(udid) {
  const { stdout, stderr } = await execFileAsync(
    'xcrun',
    ['simctl', 'launch', udid, BUNDLE_ID],
    SIMCTL_LIMIT
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

function isFileCleanInGit(repoDir, relPath) {
  const res = spawnSync('git', ['status', '--porcelain', '--', relPath], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  return res.status === 0 && res.stdout.trim().length === 0;
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('iOS Simulator startup smoke test requires macOS with Xcode.');
  }

  const options = parseSmokeCliArgs(process.argv.slice(2));
  const scratchDir = mkdtempSync(join(tmpdir(), 'lody-ios-smoke-'));
  const derivedDataPath = options.derivedData
    ? resolve(options.derivedData)
    : join(scratchDir, 'DerivedData');
  const podfileSnapshots = [];
  let createdSimulatorUdid = null;
  let activeUdid = options.udid;
  let stub = null;

  try {
    const buildEnv = buildPlaceholderBuildEnv(process.env);
    const redirectOrigins = collectRedirectOrigins(buildEnv);

    if (!options.skipBuild) {
      console.log('[ios-simulator-smoke] Building production web bundle...');
      runInherited(
        process.execPath,
        ['--max-old-space-size=8192', './node_modules/vite/bin/vite.js', 'build', '--mode', 'prod'],
        { cwd: APP_DIR, env: buildEnv }
      );
    }

    if (!existsSync(join(APP_DIR, 'dist', 'index.html'))) {
      throw new Error(
        'Missing apps/mobile-capacitor/dist/index.html; run without --skip-build first.'
      );
    }

    if (!options.skipSync) {
      for (const rel of ['ios/App/Podfile', 'ios/App/Podfile.lock']) {
        const abs = join(APP_DIR, rel);
        if (existsSync(abs) && isFileCleanInGit(APP_DIR, rel)) {
          podfileSnapshots.push({ abs, content: readFileSync(abs) });
        }
      }
      console.log('[ios-simulator-smoke] Syncing Capacitor iOS project...');
      runInherited(
        process.execPath,
        ['./node_modules/@capacitor/cli/bin/capacitor', 'sync', 'ios'],
        {
          cwd: APP_DIR,
          env: buildEnv,
        }
      );
    }

    if (!existsSync(join(IOS_APP_DIR, 'App.xcworkspace'))) {
      throw new Error(
        'Missing apps/mobile-capacitor/ios/App/App.xcworkspace; run without --skip-sync.'
      );
    }

    console.log(
      `[ios-simulator-smoke] Building App scheme (${options.configuration}) for iphonesimulator...`
    );
    runInherited(
      'xcodebuild',
      [
        '-workspace',
        'App.xcworkspace',
        '-scheme',
        'App',
        '-configuration',
        options.configuration,
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        derivedDataPath,
        'CODE_SIGN_IDENTITY=-',
        'CODE_SIGNING_ALLOWED=YES',
        'build',
      ],
      { cwd: IOS_APP_DIR, env: process.env }
    );

    const builtAppPath = join(
      derivedDataPath,
      'Build',
      'Products',
      `${options.configuration}-iphonesimulator`,
      'App.app'
    );
    if (!existsSync(builtAppPath)) {
      throw new Error(`Expected built simulator app at ${builtAppPath}`);
    }

    const scratchAppPath = join(scratchDir, 'App.app');
    cpSync(builtAppPath, scratchAppPath, { recursive: true });

    stub = await startSmokeStubServer({
      expectedPlatform: 'ios',
      timeoutMs: options.timeoutMs,
    });

    const scratchIndexPath = join(scratchAppPath, 'public', 'index.html');
    const originalHtml = readFileSync(scratchIndexPath, 'utf8');
    const probeScript = buildSmokeProbeScript({
      stubOrigin: stub.origin,
      redirectOrigins,
    });
    writeFileSync(scratchIndexPath, injectSmokeProbeHtml(originalHtml, probeScript), 'utf8');

    if (!activeUdid) {
      const simctlJson = JSON.parse(
        runCapture('xcrun', ['simctl', 'list', '-j', 'runtimes', 'devicetypes'])
      );
      const target = selectIosSimulatorTarget(simctlJson);
      const simName = `LodySmoke-${Date.now()}`;
      console.log(
        `[ios-simulator-smoke] Creating ephemeral simulator ${simName} (${target.deviceTypeName}, ${target.runtimeName})...`
      );
      createdSimulatorUdid = runCapture('xcrun', [
        'simctl',
        'create',
        simName,
        target.deviceTypeId,
        target.runtimeId,
      ]).trim();
      activeUdid = createdSimulatorUdid;
    }

    console.log(`[ios-simulator-smoke] Booting simulator ${activeUdid}...`);
    runInherited('xcrun', ['simctl', 'bootstatus', activeUdid, '-b'], {
      ...SIMCTL_LIMIT,
      timeout: 600_000,
    });

    spawnSync('xcrun', ['simctl', 'terminate', activeUdid, BUNDLE_ID], CLEANUP_OPTIONS);
    spawnSync('xcrun', ['simctl', 'uninstall', activeUdid, BUNDLE_ID], CLEANUP_OPTIONS);

    console.log('[ios-simulator-smoke] Installing scratch App.app...');
    runInherited('xcrun', ['simctl', 'install', activeUdid, scratchAppPath], SIMCTL_LIMIT);

    console.log('[ios-simulator-smoke] Launching scratch App.app...');
    await launchApp(activeUdid);
    const result = await stub.waitForResult();
    console.log(
      `[ios-simulator-smoke] PASS fresh-cold-start (platform=${result.snapshot.platform}, route=${result.snapshot.pathname}, authRequests=${result.diagnostics.authRequests.length}, errors=0, unhandledRejections=0)`
    );

    runInherited('xcrun', ['simctl', 'terminate', activeUdid, BUNDLE_ID], SIMCTL_LIMIT);
    const seed = buildRevokedSessionSeed();
    const appDataContainer = runCapture(
      'xcrun',
      ['simctl', 'get_app_container', activeUdid, BUNDLE_ID, 'data'],
      SIMCTL_LIMIT
    ).trim();
    if (!isAbsolute(appDataContainer) || !existsSync(appDataContainer)) {
      throw new Error('Simulator app data container is unavailable');
    }
    const appPlistPath = join(appDataContainer, 'Library', 'Preferences', `${BUNDLE_ID}.plist`);
    console.log('[ios-simulator-smoke] Seeding revoked session in native Preferences...');
    mkdirSync(dirname(appPlistPath), { recursive: true });
    const seededPlistPath = `${appPlistPath}.smoke-${process.pid}`;
    try {
      if (existsSync(appPlistPath)) cpSync(appPlistPath, seededPlistPath);
      else runInherited('/usr/bin/plutil', ['-create', 'binary1', seededPlistPath]);
      for (const [key, value] of [
        [seed.cookieKey, seed.cookieValue],
        [seed.sessionDataKey, seed.sessionDataValue],
      ]) {
        const keyPath = `CapacitorStorage.${key}`.replaceAll('.', '\\.');
        runInherited('/usr/bin/plutil', ['-replace', keyPath, '-string', value, seededPlistPath]);
      }
      runInherited(
        'xcrun',
        ['simctl', 'spawn', activeUdid, 'defaults', 'import', appPlistPath, seededPlistPath],
        SIMCTL_LIMIT
      );
    } finally {
      rmSync(seededPlistPath, { force: true });
    }
    stub.resetScenario({
      name: 'revoked-session-cleanup',
      expectedBearerToken: SMOKE_REVOKED_SESSION_TOKEN,
      expectClearedToken: SMOKE_REVOKED_SESSION_TOKEN,
      timeoutMs: options.timeoutMs,
    });
    console.log('[ios-simulator-smoke] Relaunching after seeding revoked session...');
    await launchApp(activeUdid);
    const revokedResult = await stub.waitForResult();
    console.log(
      `[ios-simulator-smoke] PASS revoked-session-cleanup (platform=${revokedResult.snapshot.platform}, route=${revokedResult.snapshot.pathname}, authRequests=${revokedResult.diagnostics.authRequests.length}, clearedRevokedToken=true, errors=0, unhandledRejections=0)`
    );
  } catch (error) {
    const diagnostics = stub ? stub.getDiagnostics() : null;
    if (options.artifactDir) {
      mkdirSync(options.artifactDir, { recursive: true });
      if (diagnostics) {
        writeFileSync(
          join(options.artifactDir, 'ios-simulator-smoke-diagnostics.json'),
          JSON.stringify(diagnostics, null, 2),
          'utf8'
        );
      }
      if (activeUdid) {
        spawnSync(
          'xcrun',
          [
            'simctl',
            'io',
            activeUdid,
            'screenshot',
            join(options.artifactDir, 'ios-simulator-smoke-failure.png'),
          ],
          CLEANUP_OPTIONS
        );
      }
    }
    if (diagnostics) {
      console.error(`[ios-simulator-smoke] Diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
    }
    throw error;
  } finally {
    if (activeUdid) {
      spawnSync('xcrun', ['simctl', 'terminate', activeUdid, BUNDLE_ID], CLEANUP_OPTIONS);
    }
    if (createdSimulatorUdid) {
      spawnSync('xcrun', ['simctl', 'shutdown', createdSimulatorUdid], CLEANUP_OPTIONS);
      spawnSync('xcrun', ['simctl', 'delete', createdSimulatorUdid], CLEANUP_OPTIONS);
    }
    if (stub) {
      await stub.close().catch(() => {});
    }
    for (const snapshot of podfileSnapshots) {
      writeFileSync(snapshot.abs, snapshot.content);
    }
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    `[ios-simulator-smoke] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`
  );
  process.exit(1);
});
