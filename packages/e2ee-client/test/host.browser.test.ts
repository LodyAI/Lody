type HostGlobal = typeof globalThis & {
  HostFixture: typeof import('./browser/host-fixture');
  restorePut: () => void;
  nativeBorrow: {
    entered: Promise<void>;
    release(): void;
    inspect(): { length: number; allZero: boolean };
  };
  nativePause: {
    enable(): void;
    entered: Promise<void>;
    release(): void;
    inspect(): { length: number; allZero: boolean };
    restore(): void;
  };
};
import { build } from 'esbuild';
import { chromium, webkit, type BrowserContext, type Page } from '@playwright/test';
import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const call = (p: Page, a: string) =>
  p.evaluate((action) => (globalThis as HostGlobal).HostFixture.invoke(action), a);
const record = (result: Awaited<ReturnType<typeof call>>) => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (
    !result.ok ||
    !result.value ||
    typeof result.value !== 'object' ||
    Array.isArray(result.value)
  )
    throw new Error('fixture record expected');
  return result.value as Record<string, unknown>;
};
it.each(['chromium', 'webkit'] as const)(
  'portable personal host uses genuine custody, stores, approval and mailbox in %s',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-personal-host-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        metafile: true,
        logLevel: 'silent',
      });
      expect(Object.values(output.metafile!.outputs).flatMap((o) => o.imports)).toEqual([]);
      expect(
        Object.keys(output.metafile!.inputs).some((s) =>
          /(?:node-sqlite|e2ee-node|electron)/.test(s)
        )
      ).toBe(false);
      const file = join(dir, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      const browser = engine === 'chromium' ? chromium : webkit;
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      let page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot());
      const prepared = await call(page, 'prepare');
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      expect(await call(page, 'prepare')).toEqual(prepared);
      expect((await call(page, 'wrongOffer')).ok).toBe(false);
      expect((await call(page, 'open')).reason).toBe('approval-required');
      expect((await call(page, 'events')).value).toEqual([]);
      expect((await call(page, 'begin')).value).toEqual({ status: 'pending' });
      expect((await call(page, 'foreignClaim')).reason).toBe('scope-mismatch');
      expect((await call(page, 'open')).reason).toBe('approval-required');
      expect((await call(page, 'approve')).ok).toBe(true);
      expect(await call(page, 'claim')).toEqual({ ok: true, value: { status: 'approved' } });
      expect(await call(page, 'claim')).toEqual({ ok: true, value: { status: 'approved' } });
      expect((await call(page, 'open')).ok).toBe(true);
      expect(record(await call(page, 'ledger')).length).toBe(2);
      expect((await call(page, 'keyFailure')).ok).toBe(false);
      expect((await call(page, 'ledger')).ok).toBe(true);
      expect((await call(page, 'keyRound')).ok).toBe(true);
      const sealed = await call(page, 'seal');
      expect(sealed.ok, JSON.stringify(sealed)).toBe(true);
      expect((await call(page, 'openBody')).value).toEqual([72, 105]);
      expect((await call(page, 'events')).value).toContain('installation-report');
      expect(record(await call(page, 'receipt')).recipient).toBe(record(prepared).signingPublicKey);
      expect((await call(page, 'addMachine')).ok).toBe(true);
      expect((await call(page, 'refresh')).ok).toBe(true);
      const rpc = await call(page, 'rpc');
      expect(rpc.ok, JSON.stringify(rpc)).toBe(true);
      expect(await call(page, 'rpc')).toEqual(rpc);
      expect((await call(page, 'rpcChanged')).ok).toBe(false);
      expect(await call(page, 'rpc')).toEqual(rpc);
      expect((await call(page, 'poisonSubmission')).ok).toBe(true);
      expect((await call(page, 'resumeForeign')).reason).toBe('conflict');
      expect(record(await call(page, 'ledger')).length).toBe(3);
      expect((await call(page, 'candidate')).ok).toBe(true);
      expect((await call(page, 'secondCandidate')).reason).toBe('conflict');
      expect((await call(page, 'ledger')).ok).toBe(true);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
      await context.close();
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot('open-existing'));
      expect(await call(page, 'prepare')).toEqual(prepared);
      expect((await call(page, 'open')).ok).toBe(true);
      expect((await call(page, 'openBody')).value).toEqual([72, 105]);
      expect(await call(page, 'rpc')).toEqual(rpc);
      expect((await call(page, 'rotateRemote')).ok).toBe(true);
      expect((await call(page, 'refresh')).ok).toBe(true);
      expect((await call(page, 'status')).value).toEqual({
        currentEpoch: 1,
        usableEpoch: 0,
        rotationRequired: false,
      });
      expect((await call(page, 'seal')).ok).toBe(true);
      expect((await call(page, 'stagingUnavailable')).ok).toBe(true);
      expect((await call(page, 'keyRound')).ok).toBe(true);
      expect(record(await call(page, 'status')).usableEpoch).toBe(0);
      expect((await call(page, 'ledger')).ok).toBe(true);
      // A stored group is not authority, even when its locator matched the committed epoch.
      expect((await call(page, 'stageCurrent')).ok).toBe(true);
      expect((await call(page, 'corruptStaged')).ok).toBe(true);
      expect((await call(page, 'keyRound')).ok).toBe(false);
      expect(record(await call(page, 'status')).usableEpoch).toBe(0);
      expect((await call(page, 'seal')).ok).toBe(true);
      // The publisher can disappear after staging + ledger commit, before mailbox delivery.
      expect((await call(page, 'stageCurrent')).ok).toBe(true);
      expect((await call(page, 'keyRound')).ok).toBe(true);
      expect((await call(page, 'status')).value).toEqual({
        currentEpoch: 1,
        usableEpoch: 1,
        rotationRequired: false,
      });
      expect((await call(page, 'seal')).ok).toBe(true);
      expect((await call(page, 'openBody')).value).toEqual([72, 105]);
      expect((await call(page, 'revoke')).ok).toBe(true);
      expect((await call(page, 'refresh')).ok).toBe(true);
      expect(record(await call(page, 'ledger')).length).toBe(5);
      expect((await call(page, 'seal')).ok).toBe(false);
      expect((await call(page, 'rpc')).ok).toBe(false);
      const events = (await call(page, 'events')).value;
      expect((await call(page, 'keyRound')).ok).toBe(false);
      expect((await call(page, 'events')).value).toEqual(events);
      expect((await call(page, 'corruptInstallation')).ok).toBe(true);
      expect((await call(page, 'prepare')).reason).toBe('corrupt');
      expect((await call(page, 'requestOriginal')).value).toBe(record(prepared).requestHex);
      expect((await call(page, 'close')).ok).toBe(true);
      expect((await call(page, 'ledger')).reason).toBe('closed');
      expect((await call(page, 'prepare')).reason).toBe('closed');
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'unknown relay results and close retain exact identity and claim in %s',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-personal-close-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(dir, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      const browser = engine === 'chromium' ? chromium : webkit;
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      let page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot());
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        let injected = false;
        IDBObjectStore.prototype.put = function (...args) {
          if (
            this.name === 'pairing' &&
            (args[0] as Record<string, unknown>).purpose === 'request' &&
            (args[0] as Record<string, unknown>).receipt &&
            !injected
          ) {
            injected = true;
            throw new DOMException(
              'synthetic quota after actual identity wrapping',
              'QuotaExceededError'
            );
          }
          return Reflect.apply(put, this, args);
        };
        (globalThis as HostGlobal).restorePut = () => {
          IDBObjectStore.prototype.put = put;
        };
      });
      try {
        expect((await call(page, 'prepare')).reason).toBe('capacity');
      } finally {
        await page.evaluate(() => (globalThis as HostGlobal).restorePut());
      }
      const original = (await call(page, 'requestOriginal')).value;
      const prepared = await call(page, 'prepare');
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      expect(record(prepared).requestHex).toBe(original);
      expect((await call(page, 'lostBegin')).ok).toBe(false);
      expect(await call(page, 'prepare')).toEqual(prepared);
      expect((await call(page, 'begin')).value).toEqual({ status: 'pending' });
      expect((await call(page, 'startHeld')).ok).toBe(true);
      expect((await call(page, 'close')).ok).toBe(true);
      expect((await call(page, 'heldOutcome')).value).toBe(true);
      expect((await call(page, 'events')).value).toEqual(['network-aborted']);
      expect((await call(page, 'prepare')).reason).toBe('closed');
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
      await context.close();
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot('open-existing'));
      expect(await call(page, 'prepare')).toEqual(prepared);
      expect((await call(page, 'begin')).value).toEqual({ status: 'pending' });
      expect((await call(page, 'open')).reason).toBe('approval-required');
      expect((await call(page, 'retryOffer')).reason).toBe('conflict');
      expect((await call(page, 'cancel')).value).toEqual({ status: 'cancelled' });
      const retry = await call(page, 'retryOffer');
      expect(retry.ok, JSON.stringify(retry)).toBe(true);
      expect(record(retry).signingPublicKey).toBe(record(prepared).signingPublicKey);
      expect(record(retry).requestHex).not.toBe(record(prepared).requestHex);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'new desktop approval atomically replaces the local identity and preserves the ledger origin in %s',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-personal-replace-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(dir, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      const browser = engine === 'chromium' ? chromium : webkit;
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      let page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot());
      const first = await call(page, 'prepare');
      expect((await call(page, 'approve')).ok).toBe(true);
      expect((await call(page, 'claim')).ok).toBe(true);
      expect((await call(page, 'open')).ok).toBe(true);
      expect((await call(page, 'openReader')).ok).toBe(true);
      const candidate = await call(page, 'candidate');
      expect(candidate.ok).toBe(true);
      expect(record(candidate).signingPublicKey).not.toBe(record(first).signingPublicKey);
      expect((await call(page, 'openCandidate')).reason).toBe('approval-required');
      expect((await call(page, 'ledger')).ok).toBe(true);
      expect((await call(page, 'approveCandidate')).ok).toBe(true);
      expect((await call(page, 'claimCandidate')).value).toEqual({ status: 'approved' });
      expect((await call(page, 'candidateControlFailure')).ok).toBe(false);
      expect((await call(page, 'ledger')).ok).toBe(true);
      const opened = await call(page, 'openCandidate');
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      expect((await call(page, 'oldOwner')).reason).toBe('closed');
      expect((await call(page, 'otherLedger')).reason).toBe('closed');
      expect((await call(page, 'releasedReaders')).value).toEqual([
        { device: record(first).signingPublicKey, phase: 'ready' },
      ]);
      expect(record(await call(page, 'ledger')).length).toBe(3);
      expect((await call(page, 'keyRound')).ok).toBe(true);
      expect((await call(page, 'seal')).ok).toBe(true);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
      await context.close();
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot('open-existing'));
      expect(await call(page, 'candidate')).toEqual(candidate);
      expect((await call(page, 'openCandidate')).ok).toBe(true);
      expect((await call(page, 'openBody')).value).toEqual([72, 105]);
      expect((await call(page, 'prepare')).reason).toBe('conflict');
      await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'close owns native identity plaintext until it is wiped in %s',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-personal-unwrap-close-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(dir, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      for (const purpose of [
        'signing-private-key',
        'encryption-private-key',
        'device-credential',
      ]) {
        for (const cancel of [false, true]) {
          const browser = engine === 'chromium' ? chromium : webkit;
          context = await browser.launchPersistentContext(join(dir, purpose + '-' + cancel), {
            headless: true,
          });
          const page = await context.newPage();
          await page.goto(pathToFileURL(file).href);
          // Install before custody captures the native method; enable only after approval.
          await page.evaluate((selectedPurpose) => {
            const original = SubtleCrypto.prototype.decrypt;
            let enabled = false,
              seen = 0,
              held: ArrayBuffer | undefined;
            let enter!: () => void, release!: () => void;
            const entered = new Promise<void>((resolve) => {
              enter = resolve;
            });
            const released = new Promise<void>((resolve) => {
              release = resolve;
            });
            SubtleCrypto.prototype.decrypt = async function (algorithm, key, data) {
              const result = await original.call(this, algorithm, key, data);
              const aad = (algorithm as AesGcmParams).additionalData;
              if (
                enabled &&
                aad &&
                new TextDecoder().decode(aad).includes(selectedPurpose) &&
                // Exclude the public KEK availability probe from credential acquisitions.
                (selectedPurpose !== 'device-credential' || result.byteLength > 64) &&
                ++seen === 2
              ) {
                held = result;
                enter();
                await released;
              }
              return result;
            };
            (globalThis as HostGlobal).nativePause = {
              enable() {
                enabled = true;
              },
              entered,
              release,
              inspect() {
                if (!held) throw new Error('native decrypt has not returned');
                return {
                  length: held.byteLength,
                  allZero: new Uint8Array(held).every((x) => x === 0),
                };
              },
              restore() {
                SubtleCrypto.prototype.decrypt = original;
              },
            };
          }, purpose);
          await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot());
          for (const action of ['prepare', 'approve', 'claim'])
            expect((await call(page, action)).ok).toBe(true);
          await page.evaluate(() => (globalThis as HostGlobal).nativePause.enable());
          const opening = call(page, 'open').then(
            (result) => result.ok,
            (error: unknown) => {
              if (
                !cancel ||
                !(error instanceof Error) ||
                !error.message.includes('All fibers interrupted')
              )
                throw error;
              return false;
            }
          );
          await page.evaluate(() => (globalThis as HostGlobal).nativePause.entered);
          const before = await page.evaluate(() =>
            (globalThis as HostGlobal).nativePause.inspect()
          );
          expect(before.length).toBe(purpose === 'device-credential' ? 70 : 32);
          expect(before.allZero).toBe(false);
          let closed = false;
          const closing = cancel
            ? call(page, 'close').then((result) => {
                closed = true;
                return result;
              })
            : undefined;
          if (cancel) {
            expect((await call(page, 'prepare')).reason).toBe('closed');
            expect(closed).toBe(false);
          }
          await page.evaluate(() => (globalThis as HostGlobal).nativePause.release());
          expect(await opening).toBe(!cancel);
          expect((await (closing ?? call(page, 'close'))).ok).toBe(true);
          expect(
            await page.evaluate(() => (globalThis as HostGlobal).nativePause.inspect())
          ).toEqual({ length: before.length, allZero: true });
          await page.evaluate(() => (globalThis as HostGlobal).nativePause.restore());
          await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
          await context.close();
          context = undefined;
        }
      }
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'failed identity allocation wipes prior raw secrets in %s',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-personal-allocation-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(dir, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      for (const failAt of [2, 3]) {
        const browser = engine === 'chromium' ? chromium : webkit;
        context = await browser.launchPersistentContext(join(dir, String(failAt)), {
          headless: true,
        });
        const page = await context.newPage();
        await page.goto(pathToFileURL(file).href);
        await page.evaluate(() => (globalThis as HostGlobal).HostFixture.boot());
        const result = await page.evaluate(async (failedAllocation) => {
          const original = Crypto.prototype.getRandomValues,
            owned: Uint8Array[] = [];
          let allocations = 0,
            failed = false;
          Crypto.prototype.getRandomValues = function <T extends ArrayBufferView>(array: T): T {
            if (array?.byteLength === 32 && ++allocations === failedAllocation)
              throw new DOMException('synthetic random source failure', 'OperationError');
            const generated = original.call(this, array) as T;
            if (generated instanceof Uint8Array && generated.byteLength === 32)
              owned.push(generated);
            return generated;
          };
          try {
            failed = !(await (globalThis as HostGlobal).HostFixture.invoke('prepare')).ok;
          } catch {
            failed = true;
          } finally {
            Crypto.prototype.getRandomValues = original;
          }
          return {
            failed,
            prior: owned.map((body) => ({
              length: body.byteLength,
              allZero: body.every((byte) => byte === 0),
            })),
          };
        }, failAt);
        expect(result).toEqual({
          failed: true,
          prior: Array.from({ length: failAt - 1 }, () => ({ length: 32, allZero: true })),
        });
        expect((await call(page, 'close')).ok).toBe(true);
        await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
        await context.close();
        context = undefined;
      }
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it.each(['chromium', 'webkit'] as const)(
  'bounded host and session close retain actual native borrows and locks in %s',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-bounded-close-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/host-fixture.ts', import.meta.url))],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'HostFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      const file = join(dir, 'index.html');
      await writeFile(
        file,
        '<!doctype html><script>' +
          output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      for (const kind of ['host', 'session', 'parent']) {
        const browser = engine === 'chromium' ? chromium : webkit;
        context = await browser.launchPersistentContext(join(dir, kind), { headless: true });
        const page = await context.newPage();
        await page.goto(pathToFileURL(file).href);
        await page.evaluate((ownerKind) => {
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
            const purpose = ownerKind === 'session' ? 'installed-epoch-key' : 'signing-private-key';
            if (!held && aad && new TextDecoder().decode(aad).includes(purpose)) {
              held =
                data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              enter();
              await released;
            }
            return native.call(this, algorithm, key, data);
          };
          (globalThis as HostGlobal).nativeBorrow = {
            entered,
            release,
            inspect() {
              if (!held) throw new Error('no native input');
              return { length: held.byteLength, allZero: held.every((byte) => byte === 0) };
            },
          };
        }, kind);
        await page.evaluate(() =>
          (globalThis as HostGlobal).HostFixture.boot('create-or-open', true)
        );
        try {
          if (kind === 'session') {
            for (const action of ['prepare', 'approve', 'claim', 'open', 'openReader'])
              expect((await call(page, action)).ok).toBe(true);
          }
          expect((await call(page, kind === 'session' ? 'startKeyRound' : 'startPrepare')).ok).toBe(
            true
          );
          await page.evaluate(() => (globalThis as HostGlobal).nativeBorrow.entered);
          const close = kind === 'host' ? 'startHostClose' : 'startSessionClose';
          if (kind === 'parent')
            await page.evaluate(() => (globalThis as HostGlobal).HostFixture.startParentClose());
          else {
            expect((await call(page, close)).ok).toBe(true);
          }
          expect((await call(page, 'waitCloseBudget')).ok).toBe(true);
          expect((await call(page, 'advanceCloseBudget')).ok).toBe(true);
          expect((await call(page, 'closeOutcomes')).value).toEqual(
            Array.from({ length: kind === 'parent' ? 1 : 2 }, () => ({
              state: 'failed',
              code: 'close-incomplete',
            }))
          );
          expect((await call(page, 'closeOwners')).value).toEqual({
            shared: true,
            settled: Array.from({ length: kind === 'parent' ? 1 : 2 }, () => false),
          });
          if (kind === 'session') {
            expect(record(await call(page, 'otherLedger')).length).toBe(2);
            expect((await call(page, 'status')).reason).toBe('closed');
            expect((await call(page, 'candidate')).reason).toBe('conflict');
          } else expect((await call(page, 'prepare')).reason).toBe('closed');
          const held = await page.evaluate(() => (globalThis as HostGlobal).nativeBorrow.inspect());
          expect(held.length).toBeGreaterThanOrEqual(32);
          expect(held.allZero).toBe(false);
          expect(
            await page.evaluate(async () => (await navigator.locks.query()).held!.length)
          ).toBeGreaterThan(0);
          expect((await call(page, 'requestOriginal')).ok).toBe(true);
          expect((await call(page, 'currentPhase')).value).toBe(
            kind === 'session' ? 'ready' : 'prepared'
          );
          expect(
            await page.evaluate(async () => {
              const name = (await navigator.locks.query()).held![0]!.name!;
              return navigator.locks.request(name, { ifAvailable: true }, (lock) => lock === null);
            })
          ).toBe(true);
          await page.evaluate(() => (globalThis as HostGlobal).nativeBorrow.release());
          await call(page, 'joinClose');
          expect((await call(page, kind === 'session' ? 'closeSession' : 'close')).ok).toBe(true);
          expect((await call(page, 'closeOwners')).value).toEqual({
            shared: true,
            settled: Array.from({ length: kind === 'parent' ? 1 : 2 }, () => true),
          });
          if (kind === 'session') {
            expect((await call(page, 'open')).ok).toBe(true);
            expect(record(await call(page, 'ledger')).length).toBe(2);
          } else expect((await call(page, 'open')).reason).toBe('closed');
        } finally {
          await page.evaluate(() => (globalThis as HostGlobal).nativeBorrow.release());
          await call(page, 'expireCloseWaiters');
          await call(page, 'joinClose');
          await call(page, kind === 'session' ? 'closeSession' : 'close');
          await page.evaluate(() => (globalThis as HostGlobal).HostFixture.stop());
        }
        expect(
          await page.evaluate(() => (globalThis as HostGlobal).nativeBorrow.inspect())
        ).toMatchObject({ allZero: true });
        expect(await page.evaluate(async () => (await navigator.locks.query()).held!.length)).toBe(
          0
        );
        await context.close();
        context = undefined;
      }
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);
