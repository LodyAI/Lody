import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, type Page, type BrowserContext } from '@playwright/test';
import { expect, it } from 'vitest';
import vector from './ledger-v1-vector.json';

type Fixture = {
  boot(
    name: string,
    accountId?: string,
    mode?: 'create-or-open' | 'open-existing'
  ): Promise<unknown>;
  invoke(action: string, n?: number): Promise<{ ok: boolean; value?: any; reason?: string }>;
  stop(): Promise<void>;
  readAfterClose(): Promise<string>;
};
const api = (page: Page, requestedAction: string, requestedN?: number) =>
  page.evaluate(
    ({ action, n }) =>
      (globalThis as unknown as { StoreFixture: Fixture }).StoreFixture.invoke(action, n),
    { action: requestedAction, n: requestedN }
  );
const boot = (
  page: Page,
  databaseName: string,
  requestedAccount?: string,
  requestedMode?: 'create-or-open' | 'open-existing'
) =>
  page.evaluate(
    ({ name, accountId, mode }) =>
      (globalThis as unknown as { StoreFixture: Fixture }).StoreFixture.boot(name, accountId, mode),
    { name: databaseName, accountId: requestedAccount, mode: requestedMode }
  );
const stop = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { StoreFixture: Fixture }).StoreFixture.stop());

async function mutate(
  page: Page,
  databaseName: string,
  tableName: string,
  requestedChange: 'revision' | 'origin' | 'delete' | 'orphan' | 'pairing'
) {
  return page.evaluate(
    ({ name, table, change, recordHex }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction([table], 'readwrite', { durability: 'strict' }),
            store = tx.objectStore(table);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
          if (change === 'orphan') {
            store.put(
              Uint8Array.from(recordHex.match(/../g)!, (h) => parseInt(h, 16)),
              3
            );
            return;
          }
          if (change === 'pairing') {
            const req = store.openCursor();
            req.onsuccess = () => {
              const c = req.result!;
              c.update({ ...c.value, original: Uint8Array.of(73) });
            };
            return;
          }
          const read = store.get(0);
          read.onsuccess = () => {
            const row = read.result;
            if (change === 'delete') store.delete(0);
            else if (change === 'revision') store.put({ ...row, revision: 0 }, 0);
            else {
              const origin = new Uint8Array(row.origin);
              origin[origin.length - 2] ^= 1;
              store.put({ ...row, origin }, 0);
            }
          };
        };
      }),
    {
      name: databaseName,
      table: tableName,
      change: requestedChange,
      recordHex: vector.records[2]!.hex,
    }
  );
}

async function rawFeed(page: Page, databaseName: string) {
  return page.evaluate(
    (name) =>
      new Promise((resolve, reject) => {
        const opening = indexedDB.open(name, 1);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result,
            tx = db.transaction(['feed', 'records'], 'readonly');
          let feed: unknown;
          const entries: unknown[] = [];
          const metadata = tx.objectStore('feed').get(0);
          metadata.onsuccess = () => {
            const r = metadata.result;
            feed = {
              ...r,
              origin: Array.from(r.origin),
              tail: { ...r.tail, head: Array.from(r.tail.head) },
            };
          };
          const rows = tx.objectStore('records').openCursor();
          rows.onsuccess = () => {
            const c = rows.result;
            if (!c) return;
            entries.push({
              key: c.key,
              value: c.value instanceof Uint8Array ? Array.from(c.value) : c.value,
            });
            c.continue();
          };
          tx.oncomplete = () => {
            db.close();
            resolve({ feed, entries });
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    databaseName
  );
}

it.each(['chromium', 'webkit'] as const)(
  'preserves exact originals and CAS across real %s profiles, tabs and faults',
  async (engine) => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('./browser/idb-entry.ts', import.meta.url))],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'StoreFixture',
      target: 'safari16.4',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(Object.values(bundle.metafile!.outputs).flatMap((out) => out.imports)).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'lody-idb-ledger-'));
    const file = join(dir, 'index.html'),
      url = pathToFileURL(file).href;
    await writeFile(
      file,
      '<!doctype html><script>' +
        bundle.outputFiles[0]!.text.replaceAll('</script', '<\\/script') +
        '</script>'
    );
    const browser = engine === 'chromium' ? chromium : webkit;
    let context: BrowserContext | undefined;
    try {
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      let page = await context.newPage();
      await page.goto(url);
      await boot(page, 'originals');
      expect(await api(page, 'readPin')).toEqual({ ok: true, value: null });
      for (const action of ['writePin', 'initialize', 'prepare', 'pairPrepare'])
        expect((await api(page, action)).ok).toBe(true);
      const retained = await api(page, 'snapshot');
      expect(retained.value.submission.record).toBe(vector.records[1]!.hex);
      expect(retained.value.pairing.original).toBe(vector.records[0]!.hex);
      await stop(page);
      expect(
        await page.evaluate(() =>
          (globalThis as unknown as { StoreFixture: Fixture }).StoreFixture.readAfterClose()
        )
      ).toBe('closed');
      await stop(page);
      await context.close();
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(url);
      await boot(page, 'originals', undefined, 'open-existing');
      expect(await api(page, 'snapshot')).toEqual(retained);
      expect(await api(page, 'prepare')).toEqual({ ok: true, value: undefined });
      expect((await api(page, 'prepare', 2)).reason).toBe('conflict');
      expect((await api(page, 'snapshot')).value.submission.record).toBe(vector.records[1]!.hex);
      expect((await api(page, 'acknowledge')).reason).toBe('conflict');
      expect((await api(page, 'finish')).ok).toBe(true);
      expect((await api(page, 'rollbackSubmission')).reason).toBe('conflict');
      expect((await api(page, 'acknowledge')).ok).toBe(true);
      expect((await api(page, 'snapshot')).value.submission).toEqual({
        record: null,
        outcome: null,
        checkpoint: { head: vector.records[1]!.hash, length: 2 },
      });

      const other = await context.newPage();
      await other.goto(url);
      await boot(other, 'originals');
      expect((await api(page, 'pairReplacePending')).reason).toBe('conflict');
      const appends = await Promise.all([api(page, 'append'), api(other, 'append')]);
      expect(appends.filter((r) => r.ok)).toHaveLength(1);
      expect(appends.filter((r) => r.reason === 'conflict')).toHaveLength(1);
      expect((await api(page, 'snapshot')).value.feed.records).toEqual([vector.records[1]!.hex]);
      expect((await api(page, 'appendInvalid')).ok).toBe(false);
      expect((await api(page, 'capacity')).reason).toBe('capacity');
      await api(page, 'readPin');
      await api(other, 'readPin');
      const pins = await Promise.all([api(page, 'writePin', 1), api(other, 'writePin', 2)]);
      expect(pins.filter((r) => r.ok)).toHaveLength(1);
      expect(pins.filter((r) => r.reason === 'conflict')).toHaveLength(1);
      await api(page, 'readPin');
      expect((await api(page, 'writePin', 0)).reason).toBe('conflict');
      const receipts = await Promise.all([
        api(page, 'pairReceipt', 1),
        api(other, 'pairReceipt', 2),
      ]);
      expect(receipts.filter((r) => r.ok)).toHaveLength(1);
      expect(receipts.filter((r) => r.reason === 'conflict')).toHaveLength(1);
      const original = (await api(page, 'snapshot')).value.pairing;
      expect((await api(page, 'pairReplace')).reason).toBe('conflict');
      expect((await api(page, 'snapshot')).value.pairing).toEqual(original);
      expect((await api(page, 'pairWrongScope')).reason).toBe('corrupt');
      expect((await api(page, 'pairRetryReceipt')).ok).toBe(true);
      expect((await api(page, 'pairPrepareApproval')).ok).toBe(true);
      const firstPage = await api(page, 'listFirst');
      expect(firstPage.value.entries).toHaveLength(1);
      expect(firstPage.value.next).toEqual(expect.any(String));
      const secondPage = await api(page, 'listNext');
      expect(secondPage.value.entries).toHaveLength(1);
      expect(secondPage.value.next).toBe(null);
      expect(
        new Set([firstPage.value.entries[0].key.purpose, secondPage.value.entries[0].key.purpose])
      ).toEqual(new Set(['request', 'approval']));
      expect((await api(page, 'pairPrepareClaim')).ok).toBe(true);
      const allPurposes = await api(page, 'listFirst', 64);
      expect(new Set(allPurposes.value.entries.map((entry: any) => entry.key.purpose))).toEqual(
        new Set(['request', 'approval', 'claim'])
      );
      await stop(other);
      await stop(page);

      // A committed original whose caller never received a result survives process closure.
      await boot(page, 'unknown-result');
      const unknown = api(page, 'prepareAndHold').catch(() => undefined);
      await page.waitForFunction(
        () => (globalThis as unknown as { commitReached?: boolean }).commitReached === true
      );
      await context.close();
      await unknown;
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(url);
      await boot(page, 'unknown-result', undefined, 'open-existing');
      expect((await api(page, 'snapshot')).value.submission.record).toBe(vector.records[1]!.hex);
      await stop(page);

      // Real IDB transactions, with faults at their native boundary; no crypto/network await is kept alive.
      for (const fault of ['abort', 'quota', 'mismatch'] as const) {
        await boot(page, 'fault-' + fault);
        await page.evaluate((injectedFault) => {
          const put = IDBObjectStore.prototype.put;
          (globalThis as unknown as { restorePut: () => void }).restorePut = () => {
            IDBObjectStore.prototype.put = put;
          };
          IDBObjectStore.prototype.put = function (...args) {
            if (this.name !== 'submission') return Reflect.apply(put, this, args);
            if (injectedFault === 'quota')
              throw new DOMException('synthetic quota', 'QuotaExceededError');
            if (injectedFault === 'mismatch') args[0] = { ...args[0], record: Uint8Array.of(73) };
            const request = Reflect.apply(put, this, args);
            if (injectedFault === 'abort') this.transaction.abort();
            return request;
          };
        }, fault);
        const failed = await api(page, 'prepare');
        expect(failed.ok).toBe(false);
        if (fault === 'quota') expect(failed.reason).toBe('capacity');
        await page.evaluate(() =>
          (globalThis as unknown as { restorePut: () => void }).restorePut()
        );
        expect((await api(page, 'snapshot')).value.submission.record).toBe(null);
        await stop(page);
      }
      // A failed tail write rolls back the record added earlier in the same transaction.
      await boot(page, 'partial-feed');
      await api(page, 'initialize');
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        (globalThis as any).restorePut = () => {
          IDBObjectStore.prototype.put = put;
        };
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'feed') throw new DOMException('synthetic quota', 'QuotaExceededError');
          return Reflect.apply(put, this, args);
        };
      });
      expect((await api(page, 'append')).reason).toBe('capacity');
      await page.evaluate(() => (globalThis as any).restorePut());
      expect((await api(page, 'snapshot')).value.feed.records).toEqual([]);
      expect((await api(page, 'snapshot')).value.feed.tail.count).toBe(1);
      await stop(page);

      // Hold a genuine native transaction using test-only requests, then close its owner.
      await boot(page, 'closing');
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put,
          close = IDBDatabase.prototype.close;
        const w = globalThis as any;
        w.releaseTransaction = false;
        w.closeDone = false;
        w.closeReached = false;
        w.restoreNative = () => {
          IDBObjectStore.prototype.put = put;
          IDBDatabase.prototype.close = close;
        };
        IDBDatabase.prototype.close = function () {
          w.closeReached = true;
          return Reflect.apply(close, this, []);
        };
        IDBObjectStore.prototype.put = function (...args) {
          const r = Reflect.apply(put, this, args);
          if (this.name === 'submission') {
            w.transactionEntered = true;
            const keep = () => {
              if (!w.releaseTransaction) this.get(0).onsuccess = keep;
            };
            this.get(0).onsuccess = keep;
          }
          return r;
        };
      });
      const writing = api(page, 'prepare');
      await page.waitForFunction(() => (globalThis as any).transactionEntered === true);
      const closing = stop(page).then(() =>
        page.evaluate(() => {
          (globalThis as any).closeDone = true;
        })
      );
      await page.waitForFunction(() => (globalThis as any).closeReached === true);
      try {
        expect(await page.evaluate(() => (globalThis as any).closeDone)).toBe(false);
        expect(await page.evaluate(() => (globalThis as any).StoreFixture.readAfterClose())).toBe(
          'closed'
        );
      } finally {
        await page.evaluate(() => {
          (globalThis as any).releaseTransaction = true;
        });
        await closing;
        await page.evaluate(() => (globalThis as any).restoreNative());
      }
      expect((await writing).ok).toBe(true);
      await boot(page, 'closing', undefined, 'open-existing');
      expect((await api(page, 'snapshot')).value.submission.record).toBe(vector.records[1]!.hex);
      await stop(page);

      // Restore only a caller-owned export against its independently retained endpoint/digest.
      await boot(page, 'retained');
      await api(page, 'readPin');
      await api(page, 'writePin');
      await api(page, 'initialize');
      await api(page, 'append');
      await api(page, 'readPin');
      await api(page, 'writePin', 1);
      expect((await api(page, 'rebase')).ok).toBe(true);
      const rebased = (await api(page, 'snapshot')).value.feed;
      expect(rebased.originCount).toBe(2);
      expect(rebased.tail.count).toBe(2);
      expect(rebased.records).toEqual([]);
      expect((await api(page, 'restore')).value).toEqual({
        head: vector.records[1]!.hash,
        length: 2,
      });
      await stop(page);
      await context.close();
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(url);
      await boot(page, 'retained', undefined, 'open-existing');
      expect((await api(page, 'snapshot')).value.feed).toEqual(rebased);
      expect((await api(page, 'restore')).value).toEqual({
        head: vector.records[1]!.hash,
        length: 2,
      });
      await stop(page);
      await mutate(page, 'retained', 'feed', 'origin');
      await boot(page, 'retained', undefined, 'open-existing');
      expect((await api(page, 'restore')).value).toEqual({ rejected: true });
      expect((await api(page, 'readPin')).value).toEqual({
        head: vector.records[1]!.hash,
        length: 2,
      });
      await stop(page);
      // Rebase must reject the same corrupt suffix that load rejects, retaining every byte.
      for (const fault of [
        'fraction-extra',
        'fraction-replace',
        'missing',
        'record-shape',
        'byte-total',
      ] as const) {
        const name = 'covered-rebase-' + fault;
        await boot(page, name);
        for (const action of ['initialize', 'append', 'appendThird'])
          expect((await api(page, action)).ok).toBe(true);
        await stop(page);
        await page.evaluate(
          ({ databaseName, change }) =>
            new Promise<void>((resolve, reject) => {
              const opening = indexedDB.open(databaseName, 1);
              opening.onerror = () => reject(opening.error);
              opening.onsuccess = () => {
                const db = opening.result,
                  tx = db.transaction('records', 'readwrite'),
                  store = tx.objectStore('records');
                const read = store.get(2);
                read.onsuccess = () => {
                  if (change === 'fraction-extra') store.put(read.result, 2.5);
                  else if (change === 'fraction-replace') {
                    store.delete(2);
                    store.put(read.result, 2.5);
                  } else if (change === 'missing') store.delete(2);
                  else if (change === 'record-shape') store.put({ invalid: true }, 2);
                  else store.put(Uint8Array.from([...read.result, 73]), 2);
                };
                tx.oncomplete = () => {
                  db.close();
                  resolve();
                };
                tx.onabort = () => {
                  db.close();
                  reject(tx.error);
                };
              };
            }),
          { databaseName: name, change: fault }
        );
        const before = await rawFeed(page, name);
        await boot(page, name, undefined, 'open-existing');
        expect((await api(page, 'snapshot')).reason, fault).toBe('corrupt');
        expect((await api(page, 'rebaseThird')).reason, fault).toBe('corrupt');
        await stop(page);
        expect(await rawFeed(page, name), fault).toEqual(before);
      }
      await boot(page, 'covered-rebase-valid');
      for (const action of ['initialize', 'append', 'appendThird', 'rebaseThird'])
        expect((await api(page, action)).ok).toBe(true);
      const covered = (await api(page, 'snapshot')).value.feed;
      expect(covered.originCount).toBe(3);
      expect(covered.tail.count).toBe(3);
      expect(covered.records).toEqual([]);
      await stop(page);
      // Rebase must retain an unexpected original beyond its CAS endpoint.
      await boot(page, 'orphan-rebase');
      await api(page, 'initialize');
      await api(page, 'append');
      await stop(page);
      await mutate(page, 'orphan-rebase', 'records', 'orphan');
      await boot(page, 'orphan-rebase', undefined, 'open-existing');
      expect((await api(page, 'rebase')).reason).toBe('corrupt');
      await stop(page);
      const preserved = await page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const r = indexedDB.open('orphan-rebase', 1);
            r.onerror = () => reject(r.error);
            r.onsuccess = () => {
              const db = r.result,
                tx = db.transaction('records', 'readonly');
              const count = tx.objectStore('records').count();
              count.onsuccess = () => resolve(count.result);
              tx.oncomplete = () => db.close();
            };
          })
      );
      expect(preserved).toBe(2);
      // A changed first original remains unknown; the legitimate receipt cannot overwrite it.
      await boot(page, 'mutated-pair');
      await api(page, 'pairPrepare');
      await stop(page);
      await mutate(page, 'mutated-pair', 'pairing', 'pairing');
      await boot(page, 'mutated-pair', undefined, 'open-existing');
      expect((await api(page, 'pairReceipt')).reason).toBe('conflict');
      expect((await api(page, 'snapshot')).value.pairing.original).toBe('49');
      await stop(page);
      // Corrupt journals and missing pin cells are errors, never first use.
      await boot(page, 'corrupt');
      await api(page, 'prepare');
      await stop(page);
      await mutate(page, 'corrupt', 'submission', 'revision');
      await boot(page, 'corrupt', undefined, 'open-existing');
      expect((await api(page, 'snapshot')).reason).toBe('corrupt');
      expect((await api(page, 'prepare', 2)).reason).toBe('corrupt');
      await stop(page);
      await boot(page, 'missing-pin');
      await api(page, 'readPin');
      await api(page, 'writePin');
      await stop(page);
      await mutate(page, 'missing-pin', 'pin', 'delete');
      await boot(page, 'missing-pin', undefined, 'open-existing');
      expect((await api(page, 'readPin')).reason).toBe('corrupt');
      expect((await api(page, 'writePin')).ok).toBe(false);
      await stop(page);

      await expect(boot(page, 'originals', 'wrong-account', 'open-existing')).rejects.toThrow();
      await stop(page);
      await expect(boot(page, 'never-created', undefined, 'open-existing')).rejects.toThrow();
      await stop(page);
      // Storage denial cannot manufacture an in-memory port or a fresh identity.
      await page.evaluate(() => {
        const open = IDBFactory.prototype.open;
        (globalThis as any).restoreOpen = () => {
          IDBFactory.prototype.open = open;
        };
        IDBFactory.prototype.open = function () {
          throw new DOMException('denied', 'SecurityError');
        };
      });
      try {
        await expect(boot(page, 'denied')).rejects.toThrow();
      } finally {
        await stop(page);
        await page.evaluate(() => (globalThis as any).restoreOpen());
      }
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);
