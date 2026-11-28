#!/usr/bin/env node
/**
 * Android Emulator cold-startup smoke test for @lody/mobile-capacitor.
 * Builds a debug APK carrying the production web bundle plus a temporary
 * telemetry probe in gitignored Android assets, binds adb reverse to a local
 * stub server, launches ai.lody.android/.MainActivity, and asserts that native
 * boot + Better Auth session probe converge cleanly to /login with zero
 * uncaught errors or unhandled promise rejections.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SMOKE_REVOKED_SESSION_TOKEN,
  buildAndroidSharedPrefsXml,
  buildPlaceholderBuildEnv,
  buildRevokedSessionSeed,
  buildSmokeProbeScript,
  collectRedirectOrigins,
  injectSmokeProbeHtml,
  parseSmokeCliArgs,
  startSmokeStubServer,
} from './native-startup-smoke-lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, '..');
const ANDROID_DIR = join(APP_DIR, 'android');
const ANDROID_ASSETS_INDEX = join(
  ANDROID_DIR,
  'app',
  'src',
  'main',
  'assets',
  'public',
  'index.html'
);
const PACKAGE_ID = 'ai.lody.android';
const LAUNCH_ACTIVITY = `${PACKAGE_ID}/.MainActivity`;

function resolveAndroidSdkRoot() {
  for (const candidate of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT with platform-tools and emulator installed.'
  );
}

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

function listOnlineEmulators(adbPath) {
  const output = runCapture(adbPath, ['devices']);
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
}

function findDebugApk() {
  const debugDir = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug');
  if (!existsSync(debugDir)) {
    throw new Error(`Android debug APK output directory missing: ${debugDir}`);
  }
  const output = runCapture('find', [debugDir, '-maxdepth', '2', '-type', 'f', '-name', '*.apk']);
  const apkPath = output
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!apkPath) {
    throw new Error(`No debug APK found under ${debugDir}`);
  }
  return apkPath;
}

async function waitForAndroidBoot(adbPath, emulatorProc, knownSerials, bootTimeoutMs) {
  const deadline = Date.now() + bootTimeoutMs;
  let serial = null;

  while (Date.now() < deadline) {
    if (emulatorProc.exitCode !== null || emulatorProc.signalCode !== null) {
      throw new Error(
        `Android emulator exited before boot (${emulatorProc.signalCode ?? `code ${emulatorProc.exitCode}`})`
      );
    }
    const online = listOnlineEmulators(adbPath);
    if (!serial) {
      serial = online.find((id) => !knownSerials.has(id)) || null;
    }
    if (serial) {
      const bootCompleted = spawnSync(
        adbPath,
        ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        {
          encoding: 'utf8',
        }
      );
      if (bootCompleted.status === 0 && bootCompleted.stdout.trim() === '1') {
        return serial;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }

  throw new Error(
    `Timed out after ${bootTimeoutMs}ms waiting for Android emulator to finish booting`
  );
}

async function main() {
  const options = parseSmokeCliArgs(process.argv.slice(2));
  const sdkRoot = resolveAndroidSdkRoot();
  const adbPath = join(sdkRoot, 'platform-tools', 'adb');
  const emulatorPath = join(sdkRoot, 'emulator', 'emulator');
  if (!existsSync(adbPath)) {
    throw new Error(`adb not found at ${adbPath}`);
  }

  let originalAssetsIndex = null;
  let stub = null;
  let spawnedEmulator = null;
  let activeSerial = options.serial;
  let reverseConfigured = false;

  try {
    const buildEnv = buildPlaceholderBuildEnv(process.env);
    const redirectOrigins = collectRedirectOrigins(buildEnv);

    if (!options.skipBuild) {
      console.log('[android-emulator-smoke] Building production web bundle...');
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
      console.log('[android-emulator-smoke] Syncing Capacitor Android project...');
      runInherited(
        process.execPath,
        ['./node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android'],
        { cwd: APP_DIR, env: buildEnv }
      );
      runInherited(process.execPath, [join(SCRIPT_DIR, 'normalize-android-gradle-paths.mjs')], {
        cwd: APP_DIR,
        env: buildEnv,
      });
    }

    if (!existsSync(ANDROID_ASSETS_INDEX)) {
      throw new Error(
        `Missing synced Android asset ${ANDROID_ASSETS_INDEX}; run without --skip-sync.`
      );
    }

    stub = await startSmokeStubServer({
      expectedPlatform: 'android',
      timeoutMs: options.timeoutMs,
    });

    originalAssetsIndex = readFileSync(ANDROID_ASSETS_INDEX, 'utf8');
    const probeScript = buildSmokeProbeScript({
      stubOrigin: stub.origin,
      redirectOrigins,
    });
    writeFileSync(
      ANDROID_ASSETS_INDEX,
      injectSmokeProbeHtml(originalAssetsIndex, probeScript),
      'utf8'
    );

    let apkPath = options.apk ? resolve(options.apk) : null;
    try {
      if (!apkPath) {
        console.log('[android-emulator-smoke] Building debug APK with smoke probe...');
        runInherited('./gradlew', ['--no-daemon', ':app:assembleDebug'], {
          cwd: ANDROID_DIR,
          env: {
            ...process.env,
            ANDROID_HOME: sdkRoot,
            ANDROID_SDK_ROOT: sdkRoot,
          },
        });
        apkPath = findDebugApk();
      }
    } finally {
      writeFileSync(ANDROID_ASSETS_INDEX, originalAssetsIndex, 'utf8');
      originalAssetsIndex = null;
    }

    if (!activeSerial) {
      const existing = listOnlineEmulators(adbPath);
      if (existing.length > 0 && !options.avd) {
        activeSerial = existing[0];
        console.log(`[android-emulator-smoke] Using running device/emulator ${activeSerial}...`);
      } else {
        if (!existsSync(emulatorPath)) {
          throw new Error(`Android emulator binary not found at ${emulatorPath}`);
        }
        const avds = runCapture(emulatorPath, ['-list-avds'])
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const avdName = options.avd || avds[0];
        if (!avdName) {
          throw new Error('No Android AVD found. Create an AVD or pass --serial / --avd.');
        }
        const knownSerials = new Set(existing);
        console.log(`[android-emulator-smoke] Booting headless Android AVD ${avdName}...`);
        spawnedEmulator = spawn(
          emulatorPath,
          [
            '-avd',
            avdName,
            '-no-window',
            '-no-audio',
            '-no-boot-anim',
            '-no-snapshot',
            '-gpu',
            'software',
          ],
          {
            stdio: ['ignore', 'inherit', 'inherit'],
            env: {
              ...process.env,
              ANDROID_HOME: sdkRoot,
              ANDROID_SDK_ROOT: sdkRoot,
            },
          }
        );
        await once(spawnedEmulator, 'spawn');
        const bootTimeoutMs = Number(process.env.LODY_ANDROID_EMULATOR_BOOT_TIMEOUT_MS || 240_000);
        activeSerial = await waitForAndroidBoot(
          adbPath,
          spawnedEmulator,
          knownSerials,
          bootTimeoutMs
        );
      }
    }

    console.log(
      `[android-emulator-smoke] Configuring adb reverse on ${activeSerial} (port ${stub.port})...`
    );
    runInherited(adbPath, ['-s', activeSerial, 'reverse', `tcp:${stub.port}`, `tcp:${stub.port}`]);
    reverseConfigured = true;

    console.log(`[android-emulator-smoke] Installing ${apkPath}...`);
    runInherited(adbPath, ['-s', activeSerial, 'install', '-r', apkPath]);
    spawnSync(adbPath, ['-s', activeSerial, 'shell', 'pm', 'clear', PACKAGE_ID], {
      stdio: 'ignore',
    });

    const resultPromise = stub.waitForResult();
    console.log(`[android-emulator-smoke] Launching ${LAUNCH_ACTIVITY}...`);
    runInherited(adbPath, [
      '-s',
      activeSerial,
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      LAUNCH_ACTIVITY,
    ]);

    const result = await resultPromise;
    console.log(
      `[android-emulator-smoke] PASS fresh-cold-start (platform=${result.snapshot.platform}, route=${result.snapshot.pathname}, authRequests=${result.diagnostics.authRequests.length}, errors=0, unhandledRejections=0)`
    );

    spawnSync(adbPath, ['-s', activeSerial, 'shell', 'am', 'force-stop', PACKAGE_ID], {
      stdio: 'ignore',
    });
    const seed = buildRevokedSessionSeed();
    const prefsXml = buildAndroidSharedPrefsXml({
      [seed.cookieKey]: seed.cookieValue,
      [seed.sessionDataKey]: seed.sessionDataValue,
    });
    console.log(
      '[android-emulator-smoke] Seeding revoked session in native Preferences and relaunching...'
    );
    const seedRes = spawnSync(
      adbPath,
      [
        '-s',
        activeSerial,
        'shell',
        '-T',
        `run-as ${PACKAGE_ID} sh -c 'mkdir -p shared_prefs && cat > shared_prefs/CapacitorStorage.xml'`,
      ],
      {
        input: prefsXml,
        encoding: 'utf8',
      }
    );
    if (seedRes.error) throw seedRes.error;
    if (seedRes.status !== 0) {
      throw new Error(
        `Failed to seed CapacitorStorage.xml via run-as (exit ${seedRes.status}): ${seedRes.stderr || ''}`
      );
    }

    stub.resetScenario({
      name: 'revoked-session-cleanup',
      expectedBearerToken: SMOKE_REVOKED_SESSION_TOKEN,
      expectClearedToken: SMOKE_REVOKED_SESSION_TOKEN,
      timeoutMs: options.timeoutMs,
    });
    const revokedResultPromise = stub.waitForResult();
    runInherited(adbPath, [
      '-s',
      activeSerial,
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      LAUNCH_ACTIVITY,
    ]);
    const revokedResult = await revokedResultPromise;
    console.log(
      `[android-emulator-smoke] PASS revoked-session-cleanup (platform=${revokedResult.snapshot.platform}, route=${revokedResult.snapshot.pathname}, authRequests=${revokedResult.diagnostics.authRequests.length}, clearedRevokedToken=true, errors=0, unhandledRejections=0)`
    );
  } catch (error) {
    const diagnostics = stub ? stub.getDiagnostics() : null;
    if (options.artifactDir) {
      mkdirSync(options.artifactDir, { recursive: true });
      if (activeSerial) {
        const screencap = spawnSync(adbPath, ['-s', activeSerial, 'exec-out', 'screencap', '-p'], {
          maxBuffer: 32 * 1024 * 1024,
        });
        if (screencap.status === 0 && screencap.stdout?.length) {
          writeFileSync(
            join(options.artifactDir, 'android-emulator-smoke-failure.png'),
            screencap.stdout
          );
        }
        const logcat = spawnSync(adbPath, ['-s', activeSerial, 'logcat', '-d', '-t', '250'], {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
        if (logcat.status === 0 && logcat.stdout) {
          writeFileSync(
            join(options.artifactDir, 'android-emulator-logcat.txt'),
            logcat.stdout,
            'utf8'
          );
        }
      }
      if (diagnostics) {
        writeFileSync(
          join(options.artifactDir, 'android-emulator-smoke-diagnostics.json'),
          JSON.stringify(diagnostics, null, 2),
          'utf8'
        );
      }
    }
    if (diagnostics) {
      console.error(
        `[android-emulator-smoke] Diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`
      );
    }
    throw error;
  } finally {
    if (originalAssetsIndex !== null) {
      writeFileSync(ANDROID_ASSETS_INDEX, originalAssetsIndex, 'utf8');
    }
    if (activeSerial) {
      spawnSync(adbPath, ['-s', activeSerial, 'shell', 'am', 'force-stop', PACKAGE_ID], {
        stdio: 'ignore',
      });
      if (reverseConfigured && stub) {
        spawnSync(adbPath, ['-s', activeSerial, 'reverse', '--remove', `tcp:${stub.port}`], {
          stdio: 'ignore',
        });
      }
    }
    if (spawnedEmulator) {
      if (activeSerial) {
        spawnSync(adbPath, ['-s', activeSerial, 'emu', 'kill'], { stdio: 'ignore' });
      }
      spawnedEmulator.kill('SIGTERM');
    }
    if (stub) {
      await stub.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(
    `[android-emulator-smoke] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`
  );
  process.exit(1);
});
