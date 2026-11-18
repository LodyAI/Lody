import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

export type BootProfilePoint = {
  name: string;
  atMs: number;
};

export type BootProfileSnapshot = {
  timeOrigin: number;
  points: BootProfilePoint[];
  frames: Array<{
    atMs: number;
    bodyChildCount: number;
    visibleTextLength: number;
    backgroundColor: string;
    blank: boolean;
  }>;
};

export type ElectronLaunchOptions = {
  reuseRoot?: string;
  forceOnboarding?: boolean;
  remoteDebuggingPort?: number;
};

const INHERITED_ENV_ALLOWLIST = [
  'APPDATA',
  'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY',
  'HOME',
  'LOCALAPPDATA',
  'LODY_E2E_SHOW_WINDOW',
  'LODY_NATIVE_FILE_INDEX',
  'LODY_NATIVE_REPO_MODE',
  'LODY_NATIVE_WORKSPACE_CATALOG',
  'LODY_NATIVE_MACHINE_CATALOG',
  'LODY_NATIVE_SCHEDULE_REGISTRY',
  'LODY_NATIVE_WORKSPACE_META',
  'LODY_NATIVE_SESSION_BODY',
  'LODY_NATIVE_DOCUMENT_DOMAINS',
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
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
] as const;

export function createIsolatedEnvironment(
  overrides: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_ALLOWLIST) {
    const value = inherited[name];
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
  private electronUserDataDir: string | null = null;
  private lodyDataDir: string | null = null;
  private hostPort: number | null = null;
  private hostPipe: string | null = null;
  private traceStarted = false;
  private performanceSession: CDPSession | null = null;
  private rendererPaintCount = 0;
  private bootProfile: BootProfileSnapshot | null = null;

  constructor(readonly artifacts: ScenarioArtifacts) {}

  async launch(options: ElectronLaunchOptions = {}): Promise<void> {
    if (!existsSync(MAIN_ENTRY) || !existsSync(BUNDLED_CLI_ENTRY)) {
      throw new Error(
        'Desktop E2E artifacts are missing. Run `pnpm e2e:build` before launching scenarios.'
      );
    }

    const tempBase = process.platform === 'win32' ? tmpdir() : '/tmp';
    this.tempRoot = options.reuseRoot
      ? resolve(options.reuseRoot)
      : mkdtempSync(join(tempBase, 'lody-e2e-'));
    this.electronUserDataDir = join(this.tempRoot, 'electron-user-data');
    this.lodyDataDir = join(this.tempRoot, 'lody-data');
    mkdirSync(this.electronUserDataDir, { recursive: true });
    mkdirSync(this.lodyDataDir, { recursive: true });
    if (process.platform === 'win32') {
      this.hostPipe = `\\\\.\\pipe\\lody-e2e-${randomUUID()}`;
    } else {
      this.hostPort = await reserveTcpPort();
    }

    const env = createIsolatedEnvironment({
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LODY_DATA_DIR: this.lodyDataDir,
      LODY_E2E: '1',
      LODY_E2E_BOOT_PROFILE: '1',
      ...(this.hostPort !== null ? { LODY_E2E_LOCAL_CLI_HOST_PORT: String(this.hostPort) } : {}),
      ...(this.hostPipe ? { LODY_E2E_LOCAL_CLI_HOST_PIPE: this.hostPipe } : {}),
      LODY_ELECTRON_DISABLE_SHELL_ENV: '1',
      LODY_ELECTRON_DISABLE_SYSTEM_PROXY_ENV: '1',
      // Each run owns a disposable profile. A newly downloaded Electron binary
      // must not wait on a shared macOS Keychain approval dialog during smoke.
      LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE: '1',
      ...(options.forceOnboarding === false || options.reuseRoot
        ? {}
        : { LODY_ELECTRON_FORCE_ONBOARDING: '1' }),
      LODY_ELECTRON_USER_DATA_DIR: this.electronUserDataDir,
      NODE_ENV: 'test',
    });
    this.app = await _electron.launch({
      args: [
        '--js-flags=--expose-gc',
        // GitHub-hosted Linux runners restrict unprivileged user namespaces,
        // which breaks Electron's SUID sandbox from an unpacked dev tree.
        ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
        ...(options.remoteDebuggingPort
          ? [`--remote-debugging-port=${options.remoteDebuggingPort}`]
          : []),
        MAIN_ENTRY,
        `--user-data-dir=${this.electronUserDataDir}`,
        '--lang=en-US',
        // macOS system-language detection is independent of Chromium's --lang.
        ...(process.platform === 'darwin' ? ['-AppleLanguages', '(en-US)'] : []),
      ],
      cwd: ELECTRON_DIR,
      env,
      executablePath: resolveElectronExecutable(),
      timeout: 60_000,
    });
    const childProcess = this.app.process();
    childProcess.once('exit', (code, signal) =>
      this.record('electron-main', 'exit', JSON.stringify({ pid: childProcess.pid, code, signal }))
    );
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
    // firstWindow can still expose about:blank before Electron's loadFile commits.
    // Wait for the application document, not the placeholder's readyState.
    const rendererUrl = pathToFileURL(join(ELECTRON_DIR, 'out', 'renderer', 'index.html'));
    await this.page.waitForURL((url) => url.href.split('#')[0] === rendererUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    this.bootProfile = await this.readBootProfile();
    await this.markBootPoint('document-ready-observed');
    await this.page.evaluate(
      () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()))
    );
    await this.markBootPoint('harness-first-frame');
    const expectedWindowVisibility = env.LODY_E2E_SHOW_WINDOW === '1';
    if (expectedWindowVisibility) {
      await this.app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window || window.isVisible()) return;
        await new Promise<void>((resolveShow) => window.once('show', () => resolveShow()));
      });
    }
    const windowState = await this.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        backgroundThrottling: window?.webContents.getBackgroundThrottling() ?? null,
        visible: window?.isVisible() ?? null,
      };
    });
    this.record('electron-main', 'window-state', JSON.stringify(windowState));
    if (
      windowState.visible !== expectedWindowVisibility ||
      windowState.backgroundThrottling !== false
    ) {
      throw new Error(
        `Electron E2E window policy mismatch: expected visible=${expectedWindowVisibility} and backgroundThrottling=false, received ${JSON.stringify(windowState)}`
      );
    }
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

  /** Passive inspection of this synthetic profile, never a backend initializer. */
  captureNativeFileIndexEvidence() {
    if (!this.lodyDataDir) throw new Error('Electron harness is not running');
    const independent =
      process.env.LODY_NATIVE_REPO_MODE === 'independent' ||
      process.env.LODY_NATIVE_WORKSPACE_CATALOG === '1' ||
      process.env.LODY_NATIVE_MACHINE_CATALOG === '1' ||
      process.env.LODY_NATIVE_SCHEDULE_REGISTRY === '1' ||
      process.env.LODY_NATIVE_WORKSPACE_META === '1' ||
      existsSync(join(this.lodyDataDir, 'native-repo', 'independent', 'v1'));
    const base = join(
      this.lodyDataDir,
      'native-repo',
      ...(independent ? ['independent', 'v1'] : ['v1'])
    );
    const hosts: Array<{
      pid: number | null;
      runId: string | null;
      nativeRooms: number;
      frozenRooms: number;
    }> = [];
    if (!existsSync(base)) return hosts;
    const Database = requireFromElectron('better-sqlite3') as new (
      path: string,
      options: { readonly: boolean; fileMustExist: boolean }
    ) => {
      prepare(sql: string): { all(): Array<{ stage: string; count: number }> };
      close(): void;
    };
    for (const binding of readdirSync(base).filter((name) => /^[a-f0-9]{64}$/.test(name))) {
      const root = join(base, binding);
      const path = join(root, 'routes.sqlite3');
      if (!existsSync(path)) continue;
      const db = new Database(path, { readonly: true, fileMustExist: true });
      let rows;
      try {
        rows = db
          .prepare('SELECT stage, COUNT(*) AS count FROM native_room_migrations GROUP BY stage')
          .all();
      } finally {
        db.close();
      }
      const endpointPath = join(root, independent ? 'engine' : 'engine-0.1.0-v1', 'engine.json');
      const endpoint = existsSync(endpointPath)
        ? (JSON.parse(readFileSync(endpointPath, 'utf8')) as { pid?: unknown; run_id?: unknown })
        : {};
      hosts.push({
        pid: typeof endpoint.pid === 'number' ? endpoint.pid : null,
        runId: typeof endpoint.run_id === 'string' ? endpoint.run_id : null,
        nativeRooms: rows
          .filter((row) => row.stage === 'native')
          .reduce((sum, row) => sum + row.count, 0),
        frozenRooms: rows
          .filter((row) => row.stage === 'frozen' || row.stage === 'verified')
          .reduce((sum, row) => sum + row.count, 0),
      });
    }
    return hosts;
  }

  /** Passive room/owner receipts only; never returns catalog values or credentials. */
  captureNativeWorkspaceCatalogEvidence() {
    return this.captureNativeFlockCatalogEvidence('workspace');
  }

  captureNativeMachineCatalogEvidence() {
    return this.captureNativeFlockCatalogEvidence('machine');
  }

  captureNativeScheduleRegistryEvidence() {
    return this.captureNativeFlockCatalogEvidence('schedule');
  }

  captureNativeSessionBodyEvidence(accountId: string, workspaceId: string, sessionId: string) {
    if (!this.lodyDataDir) throw new Error('Electron harness is not running');
    const base = join(this.lodyDataDir, 'native-repo', 'independent', 'v1');
    if (!existsSync(base)) return 'legacy';
    const Database = requireFromElectron('better-sqlite3') as new (
      file: string,
      options: { readonly: boolean; fileMustExist: boolean }
    ) => {
      prepare(sql: string): { all(...parameters: string[]): unknown[] };
      close(): void;
    };
    let selected: string | undefined;
    for (const name of readdirSync(base).filter((value) => /^[a-f0-9]{64}$/.test(value))) {
      const file = join(base, name, 'session-routes.sqlite3');
      if (!existsSync(file)) continue;
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare(
            'SELECT manifest,stage,receipt FROM native_loro_document_migrations WHERE binding=? AND room_id=?'
          )
          .all(JSON.stringify([accountId, workspaceId]), `session-${sessionId}`) as {
          manifest: string;
          stage: string;
          receipt: string | null;
        }[];
        for (const row of rows) {
          if (selected) throw new Error('Duplicate Session body publication');
          const manifest = JSON.parse(row.manifest);
          if (
            manifest.binding !== JSON.stringify([accountId, workspaceId]) ||
            manifest.namespace !== workspaceId ||
            manifest.roomId !== `session-${sessionId}` ||
            manifest.family !== 'session'
          )
            throw new Error('Session publication identity mismatch');
          if (row.stage === 'native') {
            const receipt = JSON.parse(row.receipt ?? 'null');
            if (!receipt || !Number.isSafeInteger(receipt.roomTxId) || receipt.roomTxId <= 0)
              throw new Error('Incomplete Session publication receipt');
            if (manifest.origin === 'created') {
              if (
                receipt.kind !== 'created' ||
                receipt.reservationId !== manifest.migrationId ||
                receipt.creationIntentSha256 !== manifest.creationIntentSha256 ||
                !/^[a-f0-9]{64}$/.test(receipt.creationIntentSha256) ||
                !Array.isArray(receipt.absence) ||
                !receipt.absence.length ||
                receipt.absence.some(
                  (source: { sourceId?: unknown; absent?: unknown }) =>
                    typeof source.sourceId !== 'string' || source.absent !== true
                ) ||
                new Set(receipt.absence.map((source: { sourceId: string }) => source.sourceId))
                  .size !== receipt.absence.length
              )
                throw new Error('Incomplete new Session reservation receipt');
            } else if (
              !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
              !Array.isArray(receipt.sources) ||
              receipt.sources.length !== manifest.sourceIds.length ||
              new Set(receipt.sources.map((source: { sourceId: string }) => source.sourceId))
                .size !== manifest.sourceIds.length ||
              receipt.sources.some(
                (source: { sourceId: string; sha256: string }) =>
                  !manifest.sourceIds.includes(source.sourceId) ||
                  !/^[a-f0-9]{64}$/.test(source.sha256)
              )
            )
              throw new Error('Incomplete migrated Session source receipt');
          }
          if (!['legacy', 'frozen', 'native', 'rollback'].includes(row.stage))
            throw new Error('Unknown Session route');
          selected = row.stage;
        }
      } finally {
        db.close();
      }
    }
    return selected ?? 'legacy';
  }

  captureNativeScheduleDefinitionEvidence(accountId: string, workspaceId: string) {
    return this.captureNativeDocumentBodyEvidence(
      accountId,
      workspaceId,
      'schedule_definition'
    ).map(({ id, ...rest }) => ({ scheduleId: id, ...rest }));
  }

  captureNativePreviewCommentEvidence(accountId: string, workspaceId: string) {
    return this.captureNativeDocumentBodyEvidence(accountId, workspaceId, 'preview_comments').map(
      ({ id, ...rest }) => ({ sessionId: id, ...rest })
    );
  }

  private captureNativeDocumentBodyEvidence(
    accountId: string,
    workspaceId: string,
    family: 'schedule_definition' | 'preview_comments'
  ) {
    if (!this.lodyDataDir) throw new Error('Electron harness is not running');
    const base = join(this.lodyDataDir, 'native-repo', 'independent', 'v1');
    const result: { id: string; stage: string; legacySqlitePresent: boolean }[] = [];
    if (!existsSync(base)) return result;
    const Database = requireFromElectron('better-sqlite3') as new (
      file: string,
      options: { readonly: boolean; fileMustExist: boolean }
    ) => { prepare(sql: string): { all(...parameters: string[]): unknown[] }; close(): void };
    const classicFile = join(this.lodyDataDir, 'loro-repo', workspaceId, 'repo.sqlite3');
    const classic = existsSync(classicFile)
      ? new Database(classicFile, { readonly: true, fileMustExist: true })
      : undefined;
    try {
      for (const name of readdirSync(base).filter((value) => /^[a-f0-9]{64}$/.test(value))) {
        const file = join(base, name, 'document-routes.sqlite3');
        if (!existsSync(file)) continue;
        const db = new Database(file, { readonly: true, fileMustExist: true });
        try {
          const rows = db
            .prepare(
              'SELECT manifest,stage,receipt FROM native_loro_document_migrations WHERE binding=?'
            )
            .all(JSON.stringify([accountId, workspaceId])) as {
            manifest: string;
            stage: string;
            receipt: string | null;
          }[];
          for (const row of rows) {
            const manifest = JSON.parse(row.manifest);
            if (manifest.family !== family) continue;
            if (
              manifest.binding !== JSON.stringify([accountId, workspaceId]) ||
              manifest.namespace !== workspaceId ||
              !manifest.roomId.startsWith(
                family === 'schedule_definition' ? 'schedule-' : 'preview-comment-'
              )
            )
              throw new Error('document publication identity mismatch');
            if (row.stage === 'native') {
              const receipt = JSON.parse(row.receipt ?? 'null');
              if (
                manifest.origin !== 'created' ||
                receipt?.kind !== 'created' ||
                receipt.family !== family ||
                receipt.reservationId !== manifest.migrationId ||
                receipt.creationIntentSha256 !== manifest.creationIntentSha256 ||
                !Number.isSafeInteger(receipt.roomTxId) ||
                receipt.roomTxId <= 0 ||
                !Array.isArray(receipt.absence) ||
                !receipt.absence.length ||
                receipt.absence.some((source: { absent?: unknown }) => source.absent !== true)
              )
                throw new Error('Incomplete native document creation receipt');
              const native = new Database(
                join(
                  base,
                  name,
                  'engine',
                  'namespaces',
                  `ns_${Buffer.from(workspaceId).toString('hex')}.sqlite3`
                ),
                { readonly: true, fileMustExist: true }
              );
              try {
                const physical = native
                  .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=1 AND room_id=?')
                  .all(manifest.roomId) as { encryption: number }[];
                if (physical.length !== 1 || physical[0]!.encryption !== 0)
                  throw new Error('Native plaintext document body missing');
              } finally {
                native.close();
              }
            }
            const legacySqlitePresent = !!classic
              ?.prepare(
                'SELECT doc_id FROM docs WHERE doc_id=? UNION SELECT doc_id FROM doc_updates WHERE doc_id=? LIMIT 1'
              )
              .all(manifest.roomId, manifest.roomId).length;
            result.push({
              id: manifest.roomId.slice(family === 'schedule_definition' ? 9 : 16),
              stage: row.stage,
              legacySqlitePresent,
            });
          }
        } finally {
          db.close();
        }
      }
    } finally {
      classic?.close();
    }
    if (new Set(result.map((row) => row.id)).size !== result.length)
      throw new Error('Duplicate document publication');
    return result;
  }

  async expectLegacyRendererBodyAbsent(workspaceId: string, roomId: string) {
    if (!this.page) throw new Error('Electron harness is not running');
    const present = await this.page.evaluate(
      async ({ workspaceId, roomId }) => {
        const prefix = `lody-loro-repo-db-${workspaceId}`;
        const databases = (await indexedDB.databases()).filter(
          (db) => db.name === prefix || db.name?.startsWith(`${prefix}:`)
        );
        for (const descriptor of databases) {
          const opening = indexedDB.open(descriptor.name!);
          opening.onupgradeneeded = () => opening.transaction?.abort();
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            opening.onsuccess = () => resolve(opening.result);
            opening.onerror = () => reject(opening.error);
          });
          try {
            if (
              db.version !== 4 ||
              !db.objectStoreNames.contains('docs') ||
              !db.objectStoreNames.contains('doc-updates')
            )
              throw new Error('Unsupported legacy renderer body layout');
            const tx = db.transaction(['docs', 'doc-updates'], 'readonly');
            const [base, updates] = await Promise.all(
              ['docs', 'doc-updates'].map(
                (store) =>
                  new Promise<unknown>((resolve, reject) => {
                    const read = tx.objectStore(store).get(roomId);
                    read.onsuccess = () => resolve(read.result);
                    read.onerror = () => reject(read.error);
                  })
              )
            );
            if (base !== undefined || updates !== undefined) return true;
          } finally {
            db.close();
          }
        }
        return false;
      },
      { workspaceId, roomId }
    );
    if (present)
      throw new Error('New native body was also authored in legacy renderer persistence');
  }

  captureNativeWorkspaceMetaEvidence() {
    return this.captureNativeFlockCatalogEvidence('meta');
  }

  private captureNativeFlockCatalogEvidence(domain: 'workspace' | 'machine' | 'schedule' | 'meta') {
    if (!this.lodyDataDir) throw new Error('Electron harness is not running');
    const base = join(this.lodyDataDir, 'native-repo', 'independent', 'v1');
    const result: Array<{
      stage: string;
      rendererOwner: string | null;
      head: number;
      proofTx: number;
    }> = [];
    if (!existsSync(base)) return result;
    const Database = requireFromElectron('better-sqlite3') as new (
      file: string,
      options: { readonly: boolean; fileMustExist: boolean }
    ) => {
      prepare(sql: string): { all(...parameters: string[]): unknown[] };
      close(): void;
    };
    const ownersFile = join(
      this.lodyDataDir,
      'native-repo',
      domain === 'workspace' ? 'renderer-wf-owners.sqlite3' : 'renderer-flock-group-owners.sqlite3'
    );
    const owners = existsSync(ownersFile)
      ? new Database(ownersFile, { readonly: true, fileMustExist: true })
      : null;
    try {
      for (const name of readdirSync(base).filter((value) => /^[a-f0-9]{64}$/.test(value))) {
        const directory = join(base, name);
        const file = join(directory, 'routes.sqlite3');
        if (!existsSync(file)) continue;
        const journal = new Database(file, { readonly: true, fileMustExist: true });
        let rows;
        try {
          rows = journal
            .prepare('SELECT stage, intent, proof FROM native_room_migrations')
            .all() as Array<{ stage: string; intent: string; proof: string | null }>;
        } finally {
          journal.close();
        }
        for (const row of rows) {
          const intent = JSON.parse(row.intent) as {
            namespace: string;
            room: { id: string; kind: string };
            binding: string;
          };
          if (
            intent.room.kind !== (domain === 'meta' ? 'meta' : 'flock') ||
            (domain === 'workspace'
              ? !intent.room.id.endsWith(':wf:workspace')
              : domain === 'machine'
                ? intent.room.id.split(':')[1] !== 'mf'
                : domain === 'schedule'
                  ? intent.room.id !== `${intent.namespace}:sr`
                  : intent.room.id !== 'meta')
          )
            continue;
          const file = join(
            directory,
            'engine',
            'namespaces',
            `ns_${Buffer.from(intent.namespace).toString('hex')}.sqlite3`
          );
          const native = new Database(file, { readonly: true, fileMustExist: true });
          let head;
          try {
            head = (
              native
                .prepare(
                  `SELECT head_tx_id AS head FROM v2_rooms WHERE room_kind=${domain === 'meta' ? 3 : 2} AND encryption=0 AND room_id=?`
                )
                .all(intent.room.id) as Array<{ head: number }>
            )[0]?.head;
          } finally {
            native.close();
          }
          if (head === undefined) throw new Error('Published catalog has no plaintext native room');
          const [accountId, workspaceId] = JSON.parse(intent.binding) as [string, string];
          const ownerKey = JSON.stringify({
            accountId,
            workspaceId,
            roomId: intent.room.id,
            contentMode: 'plaintext',
          });
          const rendererOwner = (
            domain === 'workspace'
              ? owners
                  ?.prepare('SELECT owner FROM renderer_wf_owners WHERE binding=?')
                  .all(ownerKey)
              : owners
                  ?.prepare(
                    'SELECT o.owner FROM renderer_flock_group_rooms r JOIN renderer_flock_group_owners o ON o.scope=r.group_scope WHERE r.binding=? AND r.room_id=?'
                  )
                  .all(JSON.stringify([accountId, workspaceId, 'plaintext']), intent.room.id)
          ) as Array<{ owner: string }> | undefined;
          const proofTx = row.proof ? (JSON.parse(row.proof) as { roomTxId: number }).roomTxId : -1;
          result.push({
            stage: row.stage,
            rendererOwner: rendererOwner?.[0]?.owner ?? null,
            head,
            proofTx,
          });
        }
      }
    } finally {
      owners?.close();
    }
    return result;
  }

  async markBootPoint(name: string): Promise<BootProfileSnapshot | null> {
    if (!this.page) return this.bootProfile;
    await this.page.evaluate((point) => window.__LODY_E2E_BOOT__?.mark(point), name);
    this.bootProfile = await this.readBootProfile();
    return this.bootProfile;
  }

  async captureBootProfile(): Promise<BootProfileSnapshot | null> {
    this.bootProfile = await this.readBootProfile();
    return this.bootProfile;
  }

  getIsolatedRoot(): string {
    if (!this.tempRoot) throw new Error('Electron harness has no isolated root');
    return this.tempRoot;
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

  async close(options: { preserveRoot?: boolean } = {}): Promise<void> {
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
      if (this.tempRoot && !options.preserveRoot) {
        rmSync(this.tempRoot, { recursive: true, force: true });
      }
    } catch (error) {
      closeError ??= error;
    }
    this.tempRoot = null;
    this.electronUserDataDir = null;
    this.lodyDataDir = null;
    this.hostPort = null;
    this.hostPipe = null;
    this.rendererPaintCount = 0;
    this.bootProfile = null;
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
    writeFileSync(
      join(this.artifacts.scenarioDir, 'boot.json'),
      `${JSON.stringify(this.bootProfile ?? { points: [], frames: [] }, null, 2)}\n`,
      'utf8'
    );
  }

  private async readBootProfile(): Promise<BootProfileSnapshot | null> {
    if (!this.page) return null;
    return await this.page.evaluate(() => window.__LODY_E2E_BOOT__?.snapshot() ?? null);
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
    __LODY_E2E_BOOT__?: {
      mark(name: string): void;
      snapshot(): {
        timeOrigin: number;
        points: Array<{ name: string; atMs: number }>;
        frames: Array<{
          atMs: number;
          bodyChildCount: number;
          visibleTextLength: number;
          backgroundColor: string;
          blank: boolean;
        }>;
      };
    };
  }
}
