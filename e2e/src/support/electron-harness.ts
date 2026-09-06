import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import {
  assertNamedPipeReleased,
  assertTcpPortReleased,
  reserveTcpPort,
  type ScenarioArtifacts,
} from './world-utils.js';
import {
  collectPostGcRuntimeSnapshot,
  collectRuntimeSnapshot,
  type RuntimeSnapshot,
} from './resource-probe.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ELECTRON_DIR = join(ROOT, 'apps', 'electron');
const MAIN_ENTRY = join(ELECTRON_DIR, 'out', 'main', 'index.js');
const BUNDLED_CLI_ENTRY = join(ELECTRON_DIR, 'resources', 'cli', 'index.js');
const requireFromElectron = createRequire(join(ELECTRON_DIR, 'package.json'));
const TEARDOWN_OPERATION_TIMEOUT_MS = 20_000;

async function boundedTeardown<T>(label: string, operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} exceeded ${TEARDOWN_OPERATION_TIMEOUT_MS}ms`)),
      TEARDOWN_OPERATION_TIMEOUT_MS
    );
    timeout.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resolveElectronExecutable(): string {
  const electronPackageDir = dirname(requireFromElectron.resolve('electron/package.json'));
  const relativePath = readFileSync(join(electronPackageDir, 'path.txt'), 'utf8').trim();
  return join(electronPackageDir, 'dist', relativePath);
}

type LogRecord = {
  at: string;
  source: 'electron-main' | 'renderer' | 'page' | 'request';
  level: string;
  message: string;
};

const INHERITED_ENV_ALLOWLIST = [
  'APPDATA',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XDG_RUNTIME_DIR',
] as const;

function createIsolatedEnvironment(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...overrides };
}

export class ElectronHarness {
  app: ElectronApplication | null = null;
  page: Page | null = null;
  readonly logs: LogRecord[] = [];
  readonly snapshots: RuntimeSnapshot[] = [];
  private tempRoot: string | null = null;
  private hostPort: number | null = null;
  private hostPipe: string | null = null;
  private traceStarted = false;
  private performanceSession: CDPSession | null = null;
  private rendererPaintCount = 0;

  constructor(readonly artifacts: ScenarioArtifacts) {}

  async launch(): Promise<void> {
    if (!existsSync(MAIN_ENTRY) || !existsSync(BUNDLED_CLI_ENTRY)) {
      throw new Error(
        'Desktop E2E artifacts are missing. Run `pnpm e2e:build` before launching scenarios.'
      );
    }

    const tempBase = process.platform === 'win32' ? tmpdir() : '/tmp';
    this.tempRoot = mkdtempSync(join(tempBase, 'lody-e2e-'));
    const electronUserDataDir = join(this.tempRoot, 'electron-user-data');
    const lodyDataDir = join(this.tempRoot, 'lody-data');
    mkdirSync(electronUserDataDir, { recursive: true });
    mkdirSync(lodyDataDir, { recursive: true });
    if (process.platform === 'win32') {
      this.hostPipe = `\\\\.\\pipe\\lody-e2e-${randomUUID()}`;
    } else {
      this.hostPort = await reserveTcpPort();
    }

    const env = createIsolatedEnvironment({
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LODY_DATA_DIR: lodyDataDir,
      LODY_E2E: '1',
      ...(this.hostPort !== null ? { LODY_E2E_LOCAL_CLI_HOST_PORT: String(this.hostPort) } : {}),
      ...(this.hostPipe ? { LODY_E2E_LOCAL_CLI_HOST_PIPE: this.hostPipe } : {}),
      LODY_ELECTRON_DISABLE_SHELL_ENV: '1',
      LODY_ELECTRON_DISABLE_SYSTEM_PROXY_ENV: '1',
      LODY_ELECTRON_FORCE_ONBOARDING: '1',
      LODY_ELECTRON_USER_DATA_DIR: electronUserDataDir,
      NODE_ENV: 'test',
    });
    this.app = await _electron.launch({
      args: [
        '--js-flags=--expose-gc',
        MAIN_ENTRY,
        `--user-data-dir=${electronUserDataDir}`,
        '--lang=en-US',
      ],
      cwd: ELECTRON_DIR,
      env,
      executablePath: resolveElectronExecutable(),
      timeout: 60_000,
    });
    const childProcess = this.app.process();
    childProcess.stdout?.on('data', (chunk) =>
      this.record('electron-main', 'stdout', String(chunk))
    );
    childProcess.stderr?.on('data', (chunk) =>
      this.record('electron-main', 'stderr', String(chunk))
    );

    const bootState = await this.app.evaluate(({ app, BrowserWindow }) => ({
      appReady: app.isReady(),
      diagnostic: (
        globalThis as typeof globalThis & {
          __LODY_E2E_BOOT_DIAGNOSTIC__?: { stage: string; error?: string };
        }
      ).__LODY_E2E_BOOT_DIAGNOSTIC__,
      rendererCount: BrowserWindow.getAllWindows().length,
      userDataPath: app.getPath('userData'),
    }));
    this.record('electron-main', 'boot-state', JSON.stringify(bootState));
    if (bootState.diagnostic?.stage === 'failed') {
      throw new Error(
        `Electron main boot failed:\n${bootState.diagnostic.error ?? 'unknown error'}`
      );
    }

    this.page = await this.app.firstWindow({ timeout: 60_000 });
    this.page.on('console', (message) => this.record('renderer', message.type(), message.text()));
    this.page.on('pageerror', (error) =>
      this.record('page', 'error', error.stack ?? error.message)
    );
    this.page.on('requestfailed', (request) =>
      this.record(
        'request',
        'error',
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`
      )
    );
    await this.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.traceStarted = true;
    await this.page.waitForFunction(() => document.readyState !== 'loading', undefined, {
      timeout: 60_000,
    });
    this.performanceSession = await this.page.context().newCDPSession(this.page);
    this.performanceSession.on('LayerTree.layerPainted', () => {
      this.rendererPaintCount += 1;
    });
    await this.performanceSession.send('Performance.enable');
    await this.performanceSession.send('LayerTree.enable');
    await this.page.evaluate(() => {
      if (window.__LODY_E2E_PERFORMANCE__) return;
      window.__LODY_E2E_PERFORMANCE__ = { longTaskCount: 0, longTaskDurationMs: 0 };
      const observer = new PerformanceObserver((list) => {
        const summary = window.__LODY_E2E_PERFORMANCE__;
        if (!summary) return;
        for (const entry of list.getEntries()) {
          summary.longTaskCount += 1;
          summary.longTaskDurationMs += entry.duration;
        }
      });
      try {
        observer.observe({ type: 'longtask', buffered: true });
      } catch {
        observer.disconnect();
      }
    });
  }

  async captureSnapshot(): Promise<RuntimeSnapshot> {
    if (!this.app || !this.page) throw new Error('Electron harness is not running');
    const snapshot = await collectRuntimeSnapshot(
      this.app,
      this.page,
      'ambient',
      this.performanceSession ?? undefined,
      this.rendererPaintCount
    );
    this.snapshots.push(snapshot);
    return snapshot;
  }

  async capturePostGcSnapshot(): Promise<RuntimeSnapshot> {
    if (!this.app || !this.page) throw new Error('Electron harness is not running');
    const snapshot = await collectPostGcRuntimeSnapshot(
      this.app,
      this.page,
      this.performanceSession ?? undefined,
      this.rendererPaintCount
    );
    this.snapshots.push(snapshot);
    return snapshot;
  }

  async captureCliBacklog(): Promise<unknown> {
    if (!this.page) return [];
    return await this.page.evaluate(async () => await window.ipc?.invoke('cli.getOutputBacklog'));
  }

  async stopTrace(path?: string): Promise<void> {
    if (!this.app || !this.traceStarted) return;
    this.traceStarted = false;
    await this.app.context().tracing.stop(path ? { path } : undefined);
  }

  async captureHeapSnapshots(outputDir: string): Promise<{ main: string; renderer: string }> {
    if (!this.app || !this.page) throw new Error('Electron harness is not running');
    mkdirSync(outputDir, { recursive: true });
    const mainPath = join(outputDir, 'electron-main.heapsnapshot');
    const rendererPath = join(outputDir, 'renderer.heapsnapshot');
    await this.app.evaluate(async (_runtime, targetPath) => {
      const writer = (
        globalThis as typeof globalThis & {
          __LODY_E2E_WRITE_HEAP_SNAPSHOT__?: (path: string) => string;
        }
      ).__LODY_E2E_WRITE_HEAP_SNAPSHOT__;
      if (!writer) throw new Error('Electron main E2E heap writer is unavailable');
      writer(targetPath);
    }, mainPath);

    const cdp = await this.page.context().newCDPSession(this.page);
    const rendererFd = openSync(rendererPath, 'w');
    let complete = false;
    let writeError: unknown;
    cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }: { chunk: string }) => {
      if (writeError) return;
      try {
        writeSync(rendererFd, chunk, undefined, 'utf8');
      } catch (error) {
        writeError = error;
      }
    });
    try {
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      if (writeError) throw writeError;
      fsyncSync(rendererFd);
      complete = true;
    } finally {
      try {
        await cdp.detach();
      } finally {
        closeSync(rendererFd);
        if (!complete) rmSync(rendererPath, { force: true });
      }
    }
    return { main: mainPath, renderer: rendererPath };
  }

  async close(): Promise<void> {
    let closeError: unknown;
    const appProcess = this.app?.process();
    try {
      await this.stopTrace();
    } catch (error) {
      closeError = error;
    }
    try {
      await this.performanceSession?.detach();
    } catch (error) {
      closeError ??= error;
    }
    try {
      if (this.app) await boundedTeardown('Electron application close', this.app.close());
    } catch (error) {
      closeError ??= error;
      try {
        appProcess?.kill('SIGKILL');
      } catch (killError) {
        closeError ??= killError;
      }
    } finally {
      this.app = null;
      this.page = null;
      this.performanceSession = null;
    }

    try {
      if (this.hostPort !== null) await assertTcpPortReleased(this.hostPort);
      if (this.hostPipe !== null) await assertNamedPipeReleased(this.hostPipe);
    } catch (error) {
      closeError ??= error;
    }
    try {
      if (this.tempRoot) rmSync(this.tempRoot, { recursive: true, force: true });
    } catch (error) {
      closeError ??= error;
    }
    this.tempRoot = null;
    this.hostPort = null;
    this.hostPipe = null;
    this.rendererPaintCount = 0;
    if (closeError) throw closeError;
  }

  writeDiagnostics(): void {
    writeFileSync(
      join(this.artifacts.scenarioDir, 'console.log'),
      this.logs.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8'
    );
    writeFileSync(
      join(this.artifacts.scenarioDir, 'runtime.json'),
      `${JSON.stringify({ snapshots: this.snapshots }, null, 2)}\n`,
      'utf8'
    );
  }

  private record(source: LogRecord['source'], level: string, message: string): void {
    this.logs.push({ at: new Date().toISOString(), source, level, message });
  }
}

declare global {
  interface Window {
    ipc?: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    };
    __LODY_ELECTRON__?: true;
    __LODY_E2E_PERFORMANCE__?: {
      longTaskCount: number;
      longTaskDurationMs: number;
    };
  }
}
