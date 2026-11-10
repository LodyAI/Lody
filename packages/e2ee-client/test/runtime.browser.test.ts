import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { chromium, webkit, type BrowserContext, type Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Fixture = typeof import('./browser/host-fixture');
type Surface = typeof globalThis & { HostFixture: Fixture };
const raw = (page: Page, action: string) =>
  page.evaluate((a) => (globalThis as Surface).HostFixture.invoke(a), action);
const call = (page: Page, action: string) =>
  page.evaluate((a) => (globalThis as Surface).HostFixture.runtimeInvoke(a), action);
const good = async (page: Page, action: string) => {
  const result = await call(page, action);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.value;
};

it.each(
  (['chromium', 'webkit'] as const).flatMap((engine) =>
    (['first', 'saved-snapshot', 'fork', 'rollback'] as const).map((scenario) => ({
      engine,
      scenario,
    }))
  )
)(
  'claim continuity preserves pre-approval evidence: $scenario in $engine',
  async ({ engine, scenario }) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-claim-continuity-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      const browser = engine === 'chromium' ? chromium : webkit;
      const launch = () =>
        browser.launchPersistentContext(join(directory, 'profile'), { headless: true });
      context = await launch();
      let page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(async (fixtureScenario) => {
        localStorage.setItem('empty-local-originals', 'true');
        if (fixtureScenario !== 'saved-snapshot')
          localStorage.setItem('qualify-approval-history', 'true');
        await (globalThis as Surface).HostFixture.boot();
        await (globalThis as Surface).HostFixture.bootRuntime();
      }, scenario);
      expect((await raw(page, 'addMachine')).ok).toBe(true);
      expect(await good(page, 'observeCheckpoint')).toMatchObject({ length: 2 });
      if (scenario === 'fork') expect((await raw(page, 'forkBeforeApproval')).ok).toBe(true);
      await good(page, 'prepare');
      expect((await raw(page, 'approve')).ok).toBe(true);
      if (scenario === 'rollback') {
        await page.evaluate(() => localStorage.setItem('truncate-approval-history', 'true'));
        expect((await call(page, 'claim')).ok).toBe(false);
        await page.evaluate(() => localStorage.removeItem('truncate-approval-history'));
      }
      await good(page, 'claim');
      if (scenario === 'fork') {
        expect((await call(page, 'openObserved')).reason).toBe('history-conflict');
        return;
      }
      if (scenario === 'saved-snapshot') {
        expect((await call(page, 'openObserved')).reason).toBe('history-conflict');
        await good(page, 'close');
        await context.close();
        context = await launch();
        page = await context.newPage();
        await page.goto(pathToFileURL(file).href);
        await page.evaluate(async () => {
          localStorage.setItem('qualify-approval-history', 'true');
          await (globalThis as Surface).HostFixture.boot('open-existing');
          await (globalThis as Surface).HostFixture.bootRuntime();
        });
        await good(page, 'claim');
      }
      expect(await good(page, 'openObserved')).toMatchObject({ length: 3 });
      expect(await good(page, 'ledger')).toMatchObject({ recordPositions: [0, 1, 2] });
      expect((await call(page, 'wrongCheckpoint')).reason).toBe('history-conflict');
      await good(page, 'close');
      await context.close();
      context = await launch();
      page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(async () => {
        localStorage.setItem('synthetic-offline', 'true');
        await (globalThis as Surface).HostFixture.boot('open-existing');
        await (globalThis as Surface).HostFixture.bootRuntime();
      });
      expect(await good(page, 'openObserved')).toMatchObject({ length: 3 });
      expect(await good(page, 'ledger')).toMatchObject({ recordPositions: [0, 1, 2] });
      await good(page, 'close');
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

let controlRouteBundle: Promise<string> | undefined;
const testRequire = createRequire(import.meta.url);
function bundleControlRoute() {
  controlRouteBundle ??= (async () => {
    const source = fileURLToPath(new URL('../../components/src/', import.meta.url));
    const ports = fileURLToPath(
      new URL('../../components/tests/browser/e2ee-control-route-ports.tsx', import.meta.url)
    );
    const output = await build({
      entryPoints: [
        fileURLToPath(
          new URL('../../components/tests/browser/e2ee-control-route-fixture.tsx', import.meta.url)
        ),
      ],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'ControlRouteFixture',
      target: 'safari16.4',
      write: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [
        {
          name: 'control-route-test-ports',
          setup(builder) {
            // Custody CI installs only this package's dependency closure. Resolve
            // Bare imports from the UI fixture use this installed closure too.
            builder.onResolve(
              { filter: /^react(?:-dom)?(?:\/.*)?$|^effect$|^@lody\/e2ee-core\/protocol$/ },
              ({ path }) => ({ path: testRequire.resolve(path) })
            );
            builder.onResolve(
              {
                filter:
                  /^@\/|^(?:@tanstack\/react-router|@lody\/platform\/react|jotai|react-i18next)$/,
              },
              ({ path }) => ({
                path:
                  path === '@/providers/workspace-runtime-retirements' ||
                  path === '@/lib/e2ee-ledger-history'
                    ? source + path.slice(2) + '.ts'
                    : ports,
              })
            );
          },
        },
      ],
    });
    return output.outputFiles[0].text;
  })();
  return controlRouteBundle;
}

for (const engine of ['chromium', 'webkit'] as const) {
  it.each(['describe', 'history'] as const)(
    `control route reopens after confirmed close before stale %s in ${engine}`,
    async (paused) => {
      const directory = await mkdtemp(join(tmpdir(), 'lody-control-reader-'));
      let context: BrowserContext | undefined;
      try {
        const file = join(directory, 'index.html');
        await writeFile(
          file,
          '<!doctype html><script>' +
            (await bundleControlRoute()).replaceAll('</script', '<\\/script') +
            '</script>'
        );
        context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
          join(directory, 'profile'),
          { headless: true }
        );
        const page = await context.newPage();
        const startupErrors: string[] = [];
        page.on('pageerror', (error) => startupErrors.push(error.message));
        await page.goto(pathToFileURL(file).href);
        expect(startupErrors).toEqual([]);
        const result = await page.evaluate(
          (phase) =>
            (
              globalThis as typeof globalThis & {
                ControlRouteFixture: {
                  reopen: (phase: 'describe' | 'history') => Promise<{
                    localView: { view?: string | null };
                    confirmedClose: { readers: string[] };
                    beforeNetwork: {
                      view?: string | null;
                      readers: string[];
                      publicReleased: boolean;
                    };
                    afterNetwork: unknown;
                  }>;
                };
              }
            ).ControlRouteFixture.reopen(phase),
          paused
        );
        expect(result.localView.view).toBe('1');
        expect(result.confirmedClose.readers).toEqual([]);
        expect(result.beforeNetwork.publicReleased).toBe(false);
        expect(result.beforeNetwork.view).toBe('1');
        expect(result.beforeNetwork.readers).toHaveLength(1);
        expect(result.afterNetwork).toEqual({ ...result.beforeNetwork, publicReleased: true });
      } finally {
        await context?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}

it.each(['chromium', 'webkit'] as const)(
  'shared platform runtime consumes real personal custody and approved key workflows in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-personal-runtime-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        metafile: true,
        logLevel: 'silent',
      });
      expect(Object.values(output.metafile!.outputs).flatMap((o) => o.imports)).toEqual([]);
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      const browser = engine === 'chromium' ? chromium : webkit;
      context = await browser.launchPersistentContext(join(directory, 'profile'), {
        headless: true,
      });
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(async () => {
        await (globalThis as Surface).HostFixture.boot();
        await (globalThis as Surface).HostFixture.bootRuntime();
      });
      expect((await call(page, 'open')).reason).toBe('identity-lost');
      expect(await good(page, 'accountRequester')).toBeNull();
      expect((await raw(page, 'currentPhase')).value).toBeUndefined();
      expect((await call(page, 'wrongAccount')).reason).toBe('scope-mismatch');
      expect((await call(page, 'wrongWorkspace')).reason).toBe('scope-mismatch');
      await good(page, 'prepare');
      expect((await call(page, 'open')).reason).toBe('approval-required');
      expect((await raw(page, 'events')).value).toEqual([]);
      expect((await raw(page, 'approve')).ok).toBe(true);
      expect(await good(page, 'claim')).toMatchObject({ ready: true, status: 'approved' });
      expect((await call(page, 'wrongCheckpoint')).reason).toBe('history-conflict');
      expect(await good(page, 'open')).toMatchObject({
        deviceKind: 'personal',
        hasCurrentKey: false,
        writeEpoch: null,
      });
      expect((await call(page, 'grant')).reason).toBe('keys-unavailable');
      expect((await call(page, 'seal')).ok).toBe(false);
      expect((await call(page, 'keyFailure')).ok).toBe(false);
      expect(await good(page, 'ledger')).toMatchObject({
        recordsHex: expect.any(Array),
        recordPositions: expect.any(Array),
      });
      expect(await good(page, 'receive')).toMatchObject({ hasCurrentKey: true, writeEpoch: 0 });
      expect(await good(page, 'capabilities')).toEqual({
        rpc: true,
        sharing: false,
        manager: true,
        personalManager: false,
      });
      expect(await good(page, 'grant')).toMatchObject({
        bucketId: 'protected-fixture',
        attachmentToken: 'synthetic-attachment-only',
      });
      expect(await good(page, 'rpcGrant')).toMatchObject({
        token: 'synthetic-short-lived-content',
      });
      expect((await call(page, 'badGrant')).reason).toBe('invalid-input');
      await good(page, 'sealMutable');
      expect(await good(page, 'openBody')).toEqual([72, 105]);
      expect(await good(page, 'management')).toMatchObject({
        mayRotate: true,
        devices: expect.any(Array),
      });
      const beforeRole = await good(page, 'ledger');
      expect((await call(page, 'forbiddenRole')).ok).toBe(false);
      // Ownership moves only to an existing member; nothing is signed or appended otherwise.
      expect((await call(page, 'forbiddenTransfer')).ok).toBe(false);
      expect(await good(page, 'ledger')).toEqual(beforeRole);
      expect((await raw(page, 'addMachine')).ok).toBe(true);
      await good(page, 'refresh');
      const rpc = await good(page, 'rpc');
      expect(await good(page, 'rpc')).toEqual(rpc);
      expect((await raw(page, 'rotateRemote')).ok).toBe(true);
      expect(await good(page, 'refresh')).toMatchObject({
        epoch: 1,
        hasCurrentKey: false,
        writeEpoch: 0,
      });
      expect((await raw(page, 'graceLastMillisecond')).ok).toBe(true);
      expect(await good(page, 'sealOldHint')).toEqual({ epoch: 0 });
      expect((await raw(page, 'graceExpired')).ok).toBe(true);
      expect((await call(page, 'seal')).reason).toBe('key-update-required');
      expect(await good(page, 'openBody')).toEqual([72, 105]);
      expect((await raw(page, 'stageCurrent')).ok).toBe(true);
      expect(await good(page, 'receive')).toMatchObject({ hasCurrentKey: true, writeEpoch: 1 });
      expect(await good(page, 'sealOldHint')).toEqual({ epoch: 1 });
      expect(await good(page, 'openBody')).toEqual([72, 105]);
      // Team management on the portable runtime: invite, list, admit exactly the shown
      // applicant, never twice, and never one the relay swapped after the preview.
      expect(await good(page, 'memberInvite')).toBe('link');
      const applicant = await good(page, 'memberApplicant');
      expect((await call(page, 'memberApprove')).ok).toBe(false);
      const second = await good(page, 'memberSecondApplicant');
      expect(await good(page, 'memberList')).toEqual([applicant, second]);
      expect((await call(page, 'memberAutomatic')).ok).toBe(false);
      // Asked for the first request, the relay answers with the second listed package:
      // approving the first never admits the second.
      await good(page, 'memberReadSecondAsFirst');
      expect((await call(page, 'memberApprove')).ok).toBe(false);
      expect(await good(page, 'memberSecondAdmitted')).toBe(false);
      await good(page, 'memberReadHonest');
      await good(page, 'memberSwap');
      expect(await good(page, 'memberList')).toEqual([second]);
      expect((await call(page, 'memberApprove')).ok).toBe(false);
      expect(await good(page, 'memberAdmitted')).toBe(false);
      await good(page, 'memberRestore');
      const beforeAdmission = (await good(page, 'memberRecordCount')) as number;
      // The admission lands but its reply and the read-back are both lost; once online, the
      // retry settles the same original instead of staying pending or signing again.
      await good(page, 'memberLoseReply');
      expect((await call(page, 'memberApprove')).ok).toBe(false);
      await good(page, 'memberOnline');
      expect(await good(page, 'memberApprove')).toMatchObject({ admitted: true, keyPending: true });
      expect(await good(page, 'memberAdmitted')).toBe(true);
      // The journal is settled, so later management is not left blocked behind it.
      expect(await good(page, 'management')).toMatchObject({ updatePending: false });
      expect(await good(page, 'memberRecordCount')).toBe(beforeAdmission + 1);
      expect(await good(page, 'memberApprove')).toMatchObject({ admitted: true });
      expect(await good(page, 'memberRecordCount')).toBe(beforeAdmission + 1);
      expect(await good(page, 'memberSecondAdmitted')).toBe(false);
      // A key delivery's approval sessions never leak a reader: the last release
      // closes the workspace the approval opened.
      expect(await good(page, 'approvalRelease')).toEqual({
        held: true,
        afterOne: true,
        afterAll: false,
      });
      await good(page, 'close');
      await page.evaluate(() => (globalThis as Surface).HostFixture.bootRuntime(true));
      await good(page, 'open');
      expect(await good(page, 'capabilities')).toMatchObject({ sharing: true });
      expect(await good(page, 'sharingRead')).toMatchObject({
        sharedWithTeam: false,
        projects: [],
      });
      expect(await good(page, 'sharingWrite')).toMatchObject({ status: 'saved' });
      expect(await good(page, 'sharingRead')).toMatchObject({
        sharedWithTeam: true,
        projects: ['fixture-project'],
      });
      await good(page, 'closeWrongOwner');
      expect((await call(page, 'status')).ok).toBe(true);
      await good(page, 'startGrant');
      await good(page, 'switchAccount');
      expect(await good(page, 'releaseGrant')).toEqual({ ok: false, reason: 'scope-mismatch' });
      expect((await call(page, 'accountRequester')).reason).toBe('closed');
      expect((await call(page, 'seal')).reason).toBe('closed');
      // After an account switch a delivery retry gets no approval session.
      expect((await call(page, 'approvalSession')).ok).toBe(false);
      await good(page, 'restoreAccount');
      await good(page, 'close');
      expect((await call(page, 'open')).reason).toBe('closed');
      await page.evaluate(() => (globalThis as Surface).HostFixture.bootRuntime());
      expect(await good(page, 'open')).toMatchObject({ writeEpoch: 1 });
      expect((await raw(page, 'revoke')).ok).toBe(true);
      await good(page, 'refresh');
      expect((await call(page, 'seal')).ok).toBe(false);
      expect((await call(page, 'grant')).ok).toBe(false);
      expect(
        ((await good(page, 'ledger')) as { status: { length: number } }).status.length
      ).toBeGreaterThan(2);
      await good(page, 'close');
      await page.evaluate(() => (globalThis as Surface).HostFixture.stop());
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'a failed approval-reader close keeps the release retryable in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-approval-release-'));
    let context: BrowserContext | undefined;
    type Paused = Surface & { nativeBorrow: { entered: Promise<void>; release(): void } };
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
        join(directory, 'profile'),
        { headless: true }
      );
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      // Hold one native key operation so the reader's close cannot drain in budget.
      await page.evaluate(() => {
        const native = SubtleCrypto.prototype.encrypt;
        let release!: () => void,
          enter!: () => void,
          held = false;
        const entered = new Promise<void>((resolve) => (enter = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        SubtleCrypto.prototype.encrypt = async function (algorithm, key, data) {
          const aad = (algorithm as AesGcmParams).additionalData;
          if (!held && aad && new TextDecoder().decode(aad).includes('installed-epoch-key')) {
            held = true;
            enter();
            await released;
          }
          return native.call(this, algorithm, key, data);
        };
        (globalThis as Paused).nativeBorrow = { entered, release };
      });
      await page.evaluate(async () => {
        await (globalThis as Surface).HostFixture.boot('create-or-open', true);
        await (globalThis as Surface).HostFixture.bootRuntime();
      });
      await good(page, 'prepare');
      expect((await raw(page, 'approve')).ok).toBe(true);
      await good(page, 'claim');
      try {
        // Only the approval holds the workspace.
        await good(page, 'approvalHold');
        await good(page, 'startReceive');
        await page.evaluate(() => (globalThis as Paused).nativeBorrow.entered);
        await good(page, 'startApprovalRelease');
        expect((await raw(page, 'waitCloseBudget')).ok).toBe(true);
        expect((await raw(page, 'advanceCloseBudget')).ok).toBe(true);
        expect(await good(page, 'approvalReleaseResult')).toEqual({
          state: 'failed',
          code: 'close-incomplete',
        });
        // Not silently done: the workspace still has an unfinished close.
        expect((await call(page, 'open')).reason).toBe('close-incomplete');
        await page.evaluate(() => (globalThis as Paused).nativeBorrow.release());
        await call(page, 'workResult');
        // The same holder releases again; this time the close completes.
        await good(page, 'startApprovalRelease');
        expect(await good(page, 'approvalReleaseResult')).toEqual({ state: 'released' });
        expect(await good(page, 'open')).toMatchObject({ deviceKind: 'personal' });
      } finally {
        await page.evaluate(() => (globalThis as Paused).nativeBorrow.release());
        await raw(page, 'expireCloseWaiters');
        await call(page, 'close');
      }
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'runtime close retains native ownership and refuses a successor until actual drain in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-runtime-close-'));
    let context: BrowserContext | undefined;
    type Paused = Surface & {
      nativeBorrow: {
        entered: Promise<void>;
        release(): void;
        inspect(): { allZero: boolean; length: number };
      };
    };
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
        join(directory, 'profile'),
        { headless: true }
      );
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => {
        const native = SubtleCrypto.prototype.encrypt;
        let release!: () => void, enter!: () => void, held: Uint8Array | undefined;
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        SubtleCrypto.prototype.encrypt = async function (algorithm, key, data) {
          const aad = (algorithm as AesGcmParams).additionalData;
          if (!held && aad && new TextDecoder().decode(aad).includes('installed-epoch-key')) {
            held =
              data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            enter();
            await released;
          }
          return native.call(this, algorithm, key, data);
        };
        (globalThis as Paused).nativeBorrow = {
          entered,
          release,
          inspect() {
            if (!held) throw Error('no native borrow');
            return { length: held.length, allZero: held.every((b) => b === 0) };
          },
        };
      });
      await page.evaluate(async () => {
        await (globalThis as Surface).HostFixture.boot('create-or-open', true);
        await (globalThis as Surface).HostFixture.bootRuntime();
      });
      await good(page, 'prepare');
      expect((await raw(page, 'approve')).ok).toBe(true);
      await good(page, 'claim');
      await good(page, 'open');
      expect((await raw(page, 'open')).ok).toBe(true);

      try {
        await good(page, 'startReceive');
        await page.evaluate(() => (globalThis as Paused).nativeBorrow.entered);
        await good(page, 'startClose');
        await good(page, 'startClose');
        expect((await raw(page, 'waitCloseBudget')).ok).toBe(true);
        expect((await raw(page, 'advanceCloseBudget')).ok).toBe(true);
        expect(await good(page, 'closeResults')).toEqual({
          outcomes: [
            { state: 'failed', code: 'close-incomplete' },
            { state: 'failed', code: 'close-incomplete' },
          ],
          shared: true,
        });
        expect(await good(page, 'compoundCloseFailure')).toBe(true);
        expect((await call(page, 'open')).reason).toBe('close-incomplete');
        expect((await call(page, 'status')).reason).toBe('closed');
        expect((await raw(page, 'ledger')).ok).toBe(true);
        expect(
          await page.evaluate(() => (globalThis as Paused).nativeBorrow.inspect())
        ).toMatchObject({ allZero: false });
        expect(
          await page.evaluate(async () => {
            const name = (await navigator.locks.query()).held![0]!.name!;
            return navigator.locks.request(name, { ifAvailable: true }, (lock) => lock === null);
          })
        ).toBe(true);
        await page.evaluate(() => (globalThis as Paused).nativeBorrow.release());
        expect(await good(page, 'workResult')).toMatchObject({ ok: false });
        await good(page, 'close');
        expect(
          await page.evaluate(() => (globalThis as Paused).nativeBorrow.inspect())
        ).toMatchObject({ allZero: true });
        expect(await page.evaluate(async () => (await navigator.locks.query()).held!.length)).toBe(
          0
        );
        expect(await good(page, 'open')).toMatchObject({ deviceKind: 'personal' });
        await good(page, 'close');
      } finally {
        await page.evaluate(() => (globalThis as Paused).nativeBorrow.release());
        await raw(page, 'expireCloseWaiters');
        await call(page, 'workResult');
        await call(page, 'close');
        await page.evaluate(() => (globalThis as Surface).HostFixture.stop());
      }
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'preallocated cold-open retirement preserves its native plaintext and isolates another pending reader in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-runtime-cold-close-'));
    let context: BrowserContext | undefined;
    type Cold = Surface & {
      pendingUnwrap: { enable(): void; entered: Promise<void>; release(): void; zero(): boolean };
    };
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      for (const kind of ['other-pending', 'own-pending'] as const) {
        context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
          join(directory, kind),
          { headless: true }
        );
        const page = await context.newPage();
        await page.goto(pathToFileURL(file).href);
        await page.evaluate(() => {
          const native = SubtleCrypto.prototype.decrypt;
          let enabled = false,
            held: Uint8Array | undefined,
            enter!: () => void,
            release!: () => void;
          const entered = new Promise<void>((resolve) => {
              enter = resolve;
            }),
            released = new Promise<void>((resolve) => {
              release = resolve;
            });
          SubtleCrypto.prototype.decrypt = async function (algorithm, key, data) {
            const result = await native.call(this, algorithm, key, data),
              aad = (algorithm as AesGcmParams).additionalData;
            if (
              enabled &&
              !held &&
              aad &&
              new TextDecoder().decode(aad).includes('signing-private-key')
            ) {
              held = new Uint8Array(result);
              enter();
              await released;
            }
            return result;
          };
          (globalThis as Cold).pendingUnwrap = {
            enable() {
              enabled = true;
            },
            entered,
            release,
            zero() {
              if (!held) throw Error('no native plaintext');
              return held.every((b) => b === 0);
            },
          };
        });
        await page.evaluate(async () => {
          await (globalThis as Surface).HostFixture.boot('create-or-open', true);
          await (globalThis as Surface).HostFixture.bootRuntime();
        });
        await good(page, 'prepare');
        expect((await raw(page, 'approve')).ok).toBe(true);
        await good(page, 'claim');
        await page.evaluate(() => (globalThis as Cold).pendingUnwrap.enable());
        try {
          await good(page, 'startOpen');
          await page.evaluate(() => (globalThis as Cold).pendingUnwrap.entered);
          expect(await page.evaluate(() => (globalThis as Cold).pendingUnwrap.zero())).toBe(false);
          if (kind === 'other-pending') {
            await good(page, 'startOtherOpen');
            await good(page, 'closeOtherPending');
            await page.evaluate(() => (globalThis as Cold).pendingUnwrap.release());
            expect(await good(page, 'openResults')).toMatchObject({
              primary: { ok: true },
              other: { ok: false, reason: 'closed' },
            });
            expect(await good(page, 'status')).toMatchObject({ deviceKind: 'personal' });
          } else {
            await good(page, 'startClose');
            await good(page, 'startClose');
            expect((await raw(page, 'waitCloseBudget')).ok).toBe(true);
            expect((await raw(page, 'advanceCloseBudget')).ok).toBe(true);
            expect(await good(page, 'closeResults')).toEqual({
              outcomes: [
                { state: 'failed', code: 'close-incomplete' },
                { state: 'failed', code: 'close-incomplete' },
              ],
              shared: true,
            });
            expect((await call(page, 'open')).reason).toBe('closed');
            expect(await page.evaluate(() => (globalThis as Cold).pendingUnwrap.zero())).toBe(
              false
            );
            expect((await raw(page, 'currentPhase')).value).toBe('ready');
            await page.evaluate(() => (globalThis as Cold).pendingUnwrap.release());
            expect(await good(page, 'openResults')).toMatchObject({
              primary: { ok: false, reason: 'closed' },
            });
          }
          await good(page, 'close');
          expect(await page.evaluate(() => (globalThis as Cold).pendingUnwrap.zero())).toBe(true);
        } finally {
          await page.evaluate(() => (globalThis as Cold).pendingUnwrap.release());
          await raw(page, 'expireCloseWaiters');
          await call(page, 'openResults');
          await call(page, 'close');
          await page.evaluate(() => (globalThis as Surface).HostFixture.stop());
        }
        await context.close();
        context = undefined;
      }
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

type ExecutorSurface = typeof globalThis & {
  HostFixture: typeof import('./browser/host-fixture');
  unwrapPause: { enable(): void; entered: Promise<void>; release(): void; zero(): boolean };
};
it.each(['chromium', 'webkit'] as const)(
  'owns input capture before executor entry and through actual native settlement in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-executor-ownership-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
        join(directory, 'profile'),
        { headless: true }
      );
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => {
        const native = SubtleCrypto.prototype.decrypt;
        let enabled = false,
          held: Uint8Array | undefined,
          enter!: () => void,
          release!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
          }),
          released = new Promise<void>((resolve) => {
            release = resolve;
          });
        SubtleCrypto.prototype.decrypt = async function (algorithm, key, data) {
          const result = await native.call(this, algorithm, key, data),
            aad = (algorithm as AesGcmParams).additionalData;
          if (
            enabled &&
            !held &&
            aad &&
            new TextDecoder().decode(aad).includes('installed-epoch-key')
          ) {
            held = new Uint8Array(result);
            enter();
            await released;
          }
          return result;
        };
        (globalThis as ExecutorSurface).unwrapPause = {
          enable() {
            enabled = true;
          },
          entered,
          release,
          zero() {
            if (!held) throw Error('no native buffer');
            return held.every((byte) => byte === 0);
          },
        };
      });
      await page.evaluate(async () => {
        await (globalThis as ExecutorSurface).HostFixture.boot();
        await (globalThis as ExecutorSurface).HostFixture.bootRuntime();
      });
      try {
        for (const action of ['prepare', 'claim', 'open', 'receive']) {
          if (action === 'claim')
            expect(
              (
                await page.evaluate(() =>
                  (globalThis as ExecutorSurface).HostFixture.invoke('approve')
                )
              ).ok
            ).toBe(true);
          expect(
            (
              await page.evaluate(
                (command) => (globalThis as ExecutorSurface).HostFixture.runtimeInvoke(command),
                action
              )
            ).ok,
            action
          ).toBe(true);
        }
        for (const mode of ['disposed', 'layer-failed', 'reject', 'late'] as const) {
          const result = await page.evaluate(
            (executorCase) =>
              (globalThis as ExecutorSurface).HostFixture.rejectedExecutorCopy(executorCase),
            mode
          );
          expect(result, mode).toMatchObject({
            rejected: true,
            copies: 1,
            zero: true,
            callerIntact: true,
          });
          if (mode === 'late') expect(result.lateRejected).toBe(true);
        }
        await page.evaluate(() => (globalThis as ExecutorSurface).unwrapPause.enable());
        await page.evaluate(() =>
          (globalThis as ExecutorSurface).HostFixture.startExecutorOwnedSeal()
        );
        await page.evaluate(() => (globalThis as ExecutorSurface).unwrapPause.entered);
        expect(
          await page.evaluate(() =>
            (globalThis as ExecutorSurface).HostFixture.inspectExecutorOwnedSeal()
          )
        ).toMatchObject({ copies: 1, zero: false, callerIntact: true });
        expect(await page.evaluate(() => (globalThis as ExecutorSurface).unwrapPause.zero())).toBe(
          false
        );
        await page.evaluate(() => (globalThis as ExecutorSurface).unwrapPause.release());
        expect(
          await page.evaluate(() =>
            (globalThis as ExecutorSurface).HostFixture.settleExecutorOwnedSeal()
          )
        ).toMatchObject({ copies: 1, zero: true, callerIntact: true });
        expect(await page.evaluate(() => (globalThis as ExecutorSurface).unwrapPause.zero())).toBe(
          true
        );
      } finally {
        await page.evaluate(() => (globalThis as ExecutorSurface).unwrapPause.release());
        await page.evaluate(() => (globalThis as ExecutorSurface).HostFixture.stop());
      }
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

type RetirementSurface = typeof globalThis & {
  RetirementFixture: typeof import('../../components/tests/browser/workspace-retirement-fixture');
  nativeBorrow: { entered: Promise<void>; release(): void; zero(): boolean };
};
it.each(['chromium', 'webkit'] as const)(
  'isolates independent ordinary storage from retained personal retirement in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-scoped-retirement-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [
          fileURLToPath(
            new URL(
              '../../components/tests/browser/workspace-retirement-fixture.ts',
              import.meta.url
            )
          ),
        ],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'RetirementFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
        join(directory, 'profile'),
        { headless: true }
      );
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => {
        const native = SubtleCrypto.prototype.encrypt;
        let held: Uint8Array | undefined, enter!: () => void, release!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
          }),
          released = new Promise<void>((resolve) => {
            release = resolve;
          });
        SubtleCrypto.prototype.encrypt = async function (algorithm, key, data) {
          const aad = (algorithm as AesGcmParams).additionalData;
          if (!held && aad && new TextDecoder().decode(aad).includes('installed-epoch-key')) {
            held =
              data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            enter();
            await released;
          }
          return native.call(this, algorithm, key, data);
        };
        (globalThis as RetirementSurface).nativeBorrow = {
          entered,
          release,
          zero() {
            if (!held) throw Error('no native borrow');
            return held.every((byte) => byte === 0);
          },
        };
      });
      await page.evaluate(async () => {
        const p = (globalThis as RetirementSurface).RetirementFixture.personal;
        await p.boot('create-or-open', true);
        await p.bootRuntime();
      });
      const action = (a: string) =>
        page.evaluate(
          (command) =>
            (globalThis as RetirementSurface).RetirementFixture.personal.runtimeInvoke(command),
          a
        );
      try {
        expect((await action('prepare')).ok).toBe(true);
        expect(
          (
            await page.evaluate(() =>
              (globalThis as RetirementSurface).RetirementFixture.personal.invoke('approve')
            )
          ).ok
        ).toBe(true);
        for (const a of ['claim', 'open', 'startReceive'])
          expect((await action(a)).ok, a).toBe(true);
        await page.evaluate(() => (globalThis as RetirementSurface).nativeBorrow.entered);
        await page.evaluate(() =>
          (globalThis as RetirementSurface).RetirementFixture.retirePersonal()
        );
        await page.evaluate(() =>
          (globalThis as RetirementSurface).RetirementFixture.personal.invoke('waitCloseBudget')
        );
        await page.evaluate(() =>
          (globalThis as RetirementSurface).RetirementFixture.personal.invoke('advanceCloseBudget')
        );
        expect(
          await page.evaluate(() =>
            (globalThis as RetirementSurface).RetirementFixture.closeOutcome()
          )
        ).toBe('close-incomplete');
        expect(
          await page.evaluate(() =>
            (globalThis as RetirementSurface).RetirementFixture.ordinaryDraft()
          )
        ).toEqual({ opened: true, body: 'ordinary draft remains writable' });
        expect(
          await page.evaluate(() =>
            (globalThis as RetirementSurface).RetirementFixture.samePhysicalIdentity()
          )
        ).toEqual({ blocked: true, sameOwner: true });
        expect(
          await page.evaluate(() => (globalThis as RetirementSurface).nativeBorrow.zero())
        ).toBe(false);
        expect(
          await page.evaluate(async () => {
            const name = (await navigator.locks.query()).held![0]!.name!;
            return navigator.locks.request(name, { ifAvailable: true }, (lock) => lock === null);
          })
        ).toBe(true);
        await page.evaluate(() => (globalThis as RetirementSurface).nativeBorrow.release());
        await action('workResult');
        await page.evaluate(() =>
          (globalThis as RetirementSurface).RetirementFixture.finishRetirement()
        );
        expect(
          await page.evaluate(() => (globalThis as RetirementSurface).nativeBorrow.zero())
        ).toBe(true);
        expect((await action('open')).ok).toBe(true);
        await action('close');
      } finally {
        await page.evaluate(() => (globalThis as RetirementSurface).nativeBorrow.release());
        await page.evaluate(() =>
          (globalThis as RetirementSurface).RetirementFixture.personal.invoke('expireCloseWaiters')
        );
        await action('workResult');
        await action('close');
        await page.evaluate(() =>
          (globalThis as RetirementSurface).RetirementFixture.personal.stop()
        );
      }
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

// The browser fixture uses components' build aliases; only serialized public outcomes cross this driver boundary.
type CacheSurface = typeof globalThis & {
  CustodyCacheFixture: {
    personal: Fixture;
    boot(mode: 'create-or-open' | 'open-existing'): Promise<void>;
    signOut(): Promise<{ ok: boolean }>;
    clear(enumerable: boolean, hard?: boolean): Promise<void>;
    savedOriginals(): Promise<string>;
    reopen(): Promise<{ ok: boolean; status?: unknown; reason?: unknown }>;
  };
};
it.each(['chromium', 'webkit'] as const)(
  'preserves actual custody and immutable originals through logout and cache recovery in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-custody-cache-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [
          fileURLToPath(
            new URL('../../components/tests/browser/custody-cache-fixture.ts', import.meta.url)
          ),
        ],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'CustodyCacheFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
        alias: { '@': fileURLToPath(new URL('../../components/src', import.meta.url)) },
        define: {
          'import.meta.env': JSON.stringify({ BASE_URL: '/', VITE_LODY_PLATFORM: 'cloud' }),
        },
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
        join(directory, 'profile'),
        { headless: true }
      );
      let page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      const operation = (command: string) =>
        page.evaluate(
          (commandName) =>
            (globalThis as CacheSurface).CustodyCacheFixture.personal.runtimeInvoke(commandName),
          command
        );
      await page.evaluate(() =>
        (globalThis as CacheSurface).CustodyCacheFixture.boot('create-or-open')
      );
      expect((await operation('prepare')).ok).toBe(true);
      expect(
        (
          await page.evaluate(() =>
            (globalThis as CacheSurface).CustodyCacheFixture.personal.invoke('approve')
          )
        ).ok
      ).toBe(true);
      for (const command of ['claim', 'open', 'receive'])
        expect((await operation(command)).ok, command).toBe(true);
      const status = (await operation('status')).value as { signingPublicKey: string };
      expect(
        (
          await page.evaluate(() =>
            (globalThis as CacheSurface).CustodyCacheFixture.personal.invoke('addMachine')
          )
        ).ok
      ).toBe(true);
      expect((await operation('refresh')).ok).toBe(true);
      const pending = await operation('rpc');
      expect(pending.ok).toBe(true);
      expect(pending.value).toMatchObject({
        requestId: expect.any(String),
        frameHex: expect.any(String),
      });
      await page.evaluate(() => (globalThis as CacheSurface).CustodyCacheFixture.personal.stop());
      expect(
        (await page.evaluate(() => (globalThis as CacheSurface).CustodyCacheFixture.signOut())).ok
      ).toBe(true);
      await page.evaluate(() =>
        (globalThis as CacheSurface).CustodyCacheFixture.boot('open-existing')
      );
      expect((await operation('open')).ok, 'logout keeps actual identity').toBe(true);
      expect((await operation('status')).value).toMatchObject({
        signingPublicKey: status.signingPublicKey,
        hasCurrentKey: true,
      });
      await page.evaluate(() => (globalThis as CacheSurface).CustodyCacheFixture.personal.stop());
      const originals = await page.evaluate(() =>
        (globalThis as CacheSurface).CustodyCacheFixture.savedOriginals()
      );
      for (const enumerable of [true, false]) {
        await page.evaluate(
          (canEnumerate) => (globalThis as CacheSurface).CustodyCacheFixture.clear(canEnumerate),
          enumerable
        );
        const after = await page.evaluate(() =>
          (globalThis as CacheSurface).CustodyCacheFixture.savedOriginals()
        );
        await context.close();
        context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
          join(directory, 'profile'),
          { headless: true }
        );
        page = await context.newPage();
        await page.goto(pathToFileURL(file).href);
        const reopened = await page.evaluate(() =>
          (globalThis as CacheSurface).CustodyCacheFixture.reopen()
        );
        expect(reopened, 'cache recovery reopens actual wrappers').toMatchObject({
          ok: true,
          status: { signingPublicKey: status.signingPublicKey, hasCurrentKey: true },
        });
        expect(
          after,
          'cache must preserve installation, wrappers, pins and pending originals'
        ).toBe(originals);
        expect(
          await operation('rpc'),
          'unconfirmed signed request must retry exact original'
        ).toEqual(pending);
        await page.evaluate(() => (globalThis as CacheSurface).CustodyCacheFixture.personal.stop());
      }
      await page.evaluate(() => (globalThis as CacheSurface).CustodyCacheFixture.clear(true, true));
      expect(
        await page.evaluate(() => (globalThis as CacheSurface).CustodyCacheFixture.savedOriginals())
      ).toBe('empty');
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'a teammate joins from a link invitation on the portable runtime in %s',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), 'lody-member-join-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
        join(directory, 'profile'),
        { headless: true }
      );
      const page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      // Ledger user ids encode Crockford base32 account ids; the owner is another account.
      const teammate = 'teammate';
      await page.evaluate(async (account) => {
        localStorage.setItem('qualify-approval-history', 'true');
        await (globalThis as Surface).HostFixture.boot(
          'create-or-open',
          false,
          'joiner',
          account,
          'abc'
        );
        await (globalThis as Surface).HostFixture.bootJoiner(account);
      }, teammate);
      const joining = async (action: string) => {
        const result = await page.evaluate(
          ([a, account]) => (globalThis as Surface).HostFixture.joinInvoke(a, account),
          [action, teammate] as const
        );
        return result;
      };
      const ok = async (action: string) => {
        const result = await joining(action);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        return (result as { value: unknown }).value;
      };

      const request = (await ok('prepare')) as { requestId: string; keyPackageHex: string };
      expect(request).toMatchObject({ accountId: teammate, state: 'pending' });
      // A retry resubmits the retained original; nothing is signed again.
      expect(await ok('prepare')).toMatchObject({ keyPackageHex: request.keyPackageHex });
      expect(await ok('submitted')).toEqual([request.keyPackageHex, request.keyPackageHex]);
      expect(await ok('pending')).toMatchObject({
        requestId: request.requestId,
        offer: { mode: 'link', token: 'cd'.repeat(32) },
      });
      expect(await ok('claim')).toEqual({ ready: false, state: 'pending' });
      // The relay's word is not admission: only the signed history can admit this device.
      await ok('relayClaimsEarly');
      expect((await joining('claim')).ok).toBe(false);
      expect((await joining('open')).ok).toBe(false);
      await ok('relayHonest');

      await ok('ownerAdmits');
      expect(await ok('claim')).toEqual({ ready: true, state: 'committed' });
      expect(await ok('open')).toEqual({
        deviceKind: 'personal',
        memberRole: 'member',
        membershipId: request.requestId,
      });
      // Accepted once; a later claim reuses the retained approval.
      expect(await ok('claim')).toEqual({ ready: true, state: 'committed' });
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
