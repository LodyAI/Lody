import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit, type Page, type BrowserContext } from '@playwright/test';
import { expect, it } from 'vitest';
import vector from './client-custody-vector.json';
const boot = (
  page: Page,
  name: string,
  mode = 'create-or-open',
  variant = 0,
  candidate = false,
  maxTasks = 10000,
  mismatch?: 'account' | 'workspace' | 'genesis'
) =>
  page.evaluate(
    ({ n, m, v, c, max, mismatchScope }) =>
      (globalThis as any).CustodyFixture.boot(n, m, v, c, max, mismatchScope),
    {
      n: name,
      m: mode,
      v: variant,
      c: candidate,
      max: maxTasks,
      mismatchScope: mismatch,
    }
  );
const call = (page: Page, action: string) =>
  page.evaluate((a) => (globalThis as any).CustodyFixture.invoke(a), action);
const stop = (page: Page) => page.evaluate(() => (globalThis as any).CustodyFixture.stop());
it.each(['chromium', 'webkit'] as const)(
  'persists nonextractable custody and exact identity across %s process reopen',
  async (engine) => {
    const output = await build({
      entryPoints: [fileURLToPath(new URL('./browser/custody-entry.ts', import.meta.url))],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'CustodyFixture',
      target: 'safari16.4',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(Object.values(output.metafile!.outputs).flatMap((o) => o.imports)).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'lody-client-custody-')),
      file = join(dir, 'index.html');
    await writeFile(
      file,
      '<!doctype html><script>' +
        output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
        '</script>'
    );
    const browser = engine === 'chromium' ? chromium : webkit;
    let context: BrowserContext | undefined;
    try {
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      let page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await boot(page, 'custody');
      expect(await call(page, 'status')).toEqual({ ok: true, value: 'missing' });
      expect((await call(page, 'create')).ok).toBe(false);
      for (const action of ['prepare', 'create', 'protect'])
        expect((await call(page, action)).ok, action).toBe(true);
      expect((await call(page, 'journalSeed')).ok).toBe(true);
      const journals = await call(page, 'journalRows');
      expect((await call(page, 'journalAckEarly')).reason).toBe('conflict');
      expect((await call(page, 'journalOriginalsWin')).value).toBe('5152');
      expect(await call(page, 'journalRows')).toEqual(journals);
      const pages = (await call(page, 'journalPages')).value;
      expect(pages.first.tasks.map((t: any) => t.id)).toEqual(['repair-1']);
      expect(pages.first.next).toBe('repair-1');
      expect(pages.second.tasks.map((t: any) => t.id)).toEqual(['repair-2']);
      expect(pages.second.next).toBe(null);
      expect((await call(page, 'candidateSeed')).ok).toBe(true);
      const originalCandidate = await call(page, 'candidateRows');
      expect((await call(page, 'candidateStale')).reason).toBe('conflict');
      expect((await call(page, 'candidateChanged')).reason).toBe('corrupt');
      expect(await call(page, 'candidateRows')).toEqual(originalCandidate);
      expect((await call(page, 'candidateFinish')).ok).toBe(true);
      const endedCandidate = await call(page, 'candidateRows');
      expect(endedCandidate.value.active).toBe(null);
      expect(endedCandidate.value.retained.record).toBe(originalCandidate.value.active.record);
      expect(endedCandidate.value.retained.envelopes).toBe(
        originalCandidate.value.active.envelopes
      );
      expect((await call(page, 'candidateSeed')).reason).toBe('conflict');
      expect((await call(page, 'candidateSeedMore')).ok).toBe(true);
      expect((await call(page, 'candidateUnconsume')).reason).toBe('conflict');
      expect((await call(page, 'candidateRows')).value.active.id).toBe('62'.repeat(32));
      const pendingSnapshot = await call(page, 'snapshotSeed');
      expect(pendingSnapshot.ok).toBe(true);
      const first = await call(page, 'read');
      expect(first.value.phase).toBe('protected');
      const publicProof = await call(page, 'open');
      expect(publicProof.ok).toBe(true);
      const ready = await call(page, 'read');
      expect(ready.value.phase).toBe('ready');
      await stop(page);
      await context.close();
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await boot(page, 'custody', 'open-existing');
      expect(await call(page, 'status')).toEqual({ ok: true, value: 'available' });
      expect(await call(page, 'journalRows')).toEqual(journals);
      expect((await call(page, 'snapshotRows')).value.pending).toEqual(pendingSnapshot.value);
      expect((await call(page, 'snapshotBusy')).reason).toBe('busy');
      expect((await call(page, 'snapshotMismatch')).reason).toBe('conflict');
      expect((await call(page, 'snapshotAccept')).ok).toBe(true);
      expect((await call(page, 'snapshotSecond')).ok).toBe(true);
      const currentSnapshot = (await call(page, 'snapshotRows')).value.current;
      const archived = (await call(page, 'snapshotRetryOld')).value;
      expect(archived.body).toBe(null);
      expect(archived.expiresAt).toBe(200);
      expect((await call(page, 'snapshotRows')).value.current).toEqual(currentSnapshot);
      expect((await call(page, 'journalProgress')).ok).toBe(true);
      expect((await call(page, 'journalReportChanged')).reason).toBe('conflict');
      expect((await call(page, 'journalRows')).value.receive.report).toBe('13');
      expect((await call(page, 'journalAck')).ok).toBe(true);
      expect((await call(page, 'journalResults')).value).toEqual({
        receive: [],
        repair: { tasks: [], next: null },
        distribution: { tasks: [], next: null },
      });
      expect((await call(page, 'journalRows')).value.receive.phase).toBe('Reported');
      expect(await call(page, 'read')).toEqual(ready);
      expect(await call(page, 'open')).toEqual(publicProof);
      for (const action of ['wrongPurpose', 'badVersion', 'badTag'])
        expect((await call(page, action)).ok, action).toBe(false);
      expect(await call(page, 'read')).toEqual(ready);
      await stop(page);
      // The KEK is the actual persisted native key, not an extractable copy or a memory-only stand-in.
      const protectedKey = await page.evaluate(
        () =>
          new Promise<any>((resolve, reject) => {
            const r = indexedDB.open('custody', 1);
            r.onerror = () => reject(r.error);
            r.onsuccess = () => {
              const db = r.result,
                tx = db.transaction('keys', 'readonly'),
                all = tx.objectStore('keys').getAll();
              all.onsuccess = async () => {
                const key = all.result[0].key;
                let exportFailed = false;
                try {
                  await crypto.subtle.exportKey('raw', key);
                } catch {
                  exportFailed = true;
                }
                resolve({ extractable: key.extractable, exportFailed, algorithm: key.algorithm });
              };
              tx.oncomplete = () => db.close();
            };
          })
      );
      expect(protectedKey).toEqual({
        extractable: false,
        exportFailed: true,
        algorithm: { name: 'AES-GCM', length: 256 },
      });
      // Lost native encryption result keeps a reserved intent; a repeated RNG output cannot restart it.
      await page.evaluate(() => {
        const random = crypto.getRandomValues.bind(crypto),
          encrypt = SubtleCrypto.prototype.encrypt;
        let draws = 0,
          lost = false;
        Object.defineProperty(crypto, 'getRandomValues', {
          configurable: true,
          value: (array: any) => {
            array.fill(draws++ === 0 ? 0x21 : 0x37);
            return array;
          },
        });
        SubtleCrypto.prototype.encrypt = async function (...args) {
          const result = await Reflect.apply(encrypt, this, args);
          if ((args[2] as Uint8Array).byteLength === 32 && !lost) {
            lost = true;
            throw new DOMException('synthetic lost result', 'OperationError');
          }
          return result;
        };
        (globalThis as any).restoreNative = () => {
          Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: random });
          SubtleCrypto.prototype.encrypt = encrypt;
        };
      });
      try {
        await boot(page, 'unknown-wrap');
        for (const action of ['prepare', 'create'])
          expect((await call(page, action)).ok).toBe(true);
        expect((await call(page, 'wrapSigning')).ok).toBe(false);
        expect((await call(page, 'wrapSigning')).reason).toBe('indeterminate');
      } finally {
        await stop(page);
        await page.evaluate(() => (globalThis as any).restoreNative());
      }
      await boot(page, 'custody', 'open-existing');
      const beforeReadOnly = await call(page, 'read');
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        (globalThis as any).restorePut = () => {
          IDBObjectStore.prototype.put = put;
        };
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'meta') return this.get(args[1]!);
          return Reflect.apply(put, this, args);
        };
      });
      try {
        expect((await call(page, 'status')).ok).toBe(false);
      } finally {
        await page.evaluate(() => (globalThis as any).restorePut());
      }
      expect(await call(page, 'read')).toEqual(beforeReadOnly);
      await stop(page);
      // Only this synthetic test imports the public vector KEK into native IDB; production exposes no KEK import or nonce override.
      await page.evaluate(() => {
        const nativeRandom = crypto.getRandomValues.bind(crypto);
        (globalThis as any).restoreVectorRandom = () =>
          Object.defineProperty(crypto, 'getRandomValues', {
            configurable: true,
            value: nativeRandom,
          });
        Object.defineProperty(crypto, 'getRandomValues', {
          configurable: true,
          value: (array: any) => {
            array.fill(1);
            return array;
          },
        });
      });
      await boot(page, 'fixed-vectors');
      for (const action of ['prepare', 'create']) expect((await call(page, action)).ok).toBe(true);
      await stop(page);
      await page.evaluate(() => (globalThis as any).restoreVectorRandom());
      await page.evaluate(async (v) => {
        const bytes = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
        const opening = indexedDB.open('fixed-vectors', 1);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          opening.onsuccess = () => resolve(opening.result);
          opening.onerror = () => reject(opening.error);
        });
        try {
          const saved = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction(['keys', 'markers'], 'readonly');
            let key: any, marker: any;
            const k = tx.objectStore('keys').openCursor(),
              m = tx.objectStore('markers').openCursor();
            k.onsuccess = () => {
              key = { id: k.result!.key, value: k.result!.value };
            };
            m.onsuccess = () => {
              marker = { id: m.result!.key, value: m.result!.value };
            };
            tx.oncomplete = () => resolve({ key, marker });
            tx.onabort = () => reject(tx.error);
          });
          const old = saved.marker.value.probe as Uint8Array,
            additionalData = bytes(v.vectors[2].aadHex);
          const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: old.slice(1, 13), additionalData, tagLength: 128 },
            saved.key.value.key,
            old.slice(13)
          );
          const key = await crypto.subtle.importKey('raw', bytes(v.kekHex), 'AES-GCM', false, [
            'encrypt',
            'decrypt',
          ]);
          const probe = new Uint8Array([
            1,
            ...old.slice(1, 13),
            ...new Uint8Array(
              await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: old.slice(1, 13), additionalData, tagLength: 128 },
                key,
                plaintext
              )
            ),
          ]);
          new Uint8Array(plaintext).fill(0);
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['keys', 'markers'], 'readwrite');
            tx.objectStore('keys').put({ ...saved.key.value, key }, saved.key.id);
            tx.objectStore('markers').put({ ...saved.marker.value, probe }, saved.marker.id);
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
        } finally {
          db.close();
        }
        let index = 0;
        const nativeRandom = crypto.getRandomValues.bind(crypto);
        (globalThis as any).restoreVectorRandom = () =>
          Object.defineProperty(crypto, 'getRandomValues', {
            configurable: true,
            value: nativeRandom,
          });
        Object.defineProperty(crypto, 'getRandomValues', {
          configurable: true,
          value: (array: any) => {
            if (index >= v.vectors.length)
              throw new Error('unexpected random draw during retained retry');
            array.set(bytes(v.vectors[index++].nonceHex));
            return array;
          },
        });
      }, vector);
      try {
        await boot(page, 'fixed-vectors', 'open-existing');
        const wrapped = await call(page, 'wrapVectors');
        expect(wrapped).toEqual({ ok: true, value: vector.vectors.map((v) => v.blobHex) });
        expect(await call(page, 'wrapVectors')).toEqual(wrapped);
      } finally {
        await stop(page);
        await page.evaluate(() => (globalThis as any).restoreVectorRandom());
      }
      await boot(page, 'interrupted-wrappers');
      for (const action of ['prepare', 'create']) expect((await call(page, action)).ok).toBe(true);
      const firstWrappers = await call(page, 'wrapOnly');
      expect(firstWrappers.ok).toBe(true);
      expect((await call(page, 'read')).value.phase).toBe('prepared');
      await stop(page);
      await boot(page, 'interrupted-wrappers', 'open-existing');
      expect((await call(page, 'identityOriginals')).value).toEqual(firstWrappers.value);
      expect((await call(page, 'restoreProtected')).ok).toBe(true);
      expect((await call(page, 'open')).ok).toBe(true);
      await stop(page);
      // An initial slot is one CAS position, even when tabs propose different identities.
      const peer = await context.newPage();
      await peer.goto(pathToFileURL(file).href);
      await boot(page, 'initial-race');
      await boot(peer, 'initial-race', 'open-existing', 1);
      const race = await Promise.all([call(page, 'prepare'), call(peer, 'prepare')]);
      expect(race.filter((r) => r.ok)).toHaveLength(1);
      expect(race.filter((r) => r.reason === 'conflict')).toHaveLength(1);
      expect(await call(page, 'read')).toEqual(await call(peer, 'read'));
      await stop(page);
      await stop(peer);
      // Storage-only replacement: the host, outside this test, supplies desktop approval and drains old users.
      await boot(page, 'replacement');
      for (const action of ['prepare', 'create', 'protect', 'open', 'journalSeed'])
        expect((await call(page, action)).ok, action).toBe(true);
      const oldReceipt = (await call(page, 'read')).value,
        oldJournals = await call(page, 'journalRows');
      await stop(page);
      // The old receipt remains valid local evidence even after its KEK is lost.
      await page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const r = indexedDB.open('replacement', 1);
            r.onerror = () => reject(r.error);
            r.onsuccess = () => {
              const db = r.result,
                tx = db.transaction('keys', 'readwrite');
              tx.objectStore('keys').clear();
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => reject(tx.error);
            };
          })
      );
      await boot(page, 'replacement', 'open-existing', 1, true);
      for (const action of ['candidateRequest', 'create', 'wrapOnly'])
        expect((await call(page, action)).ok, action).toBe(true);
      expect((await call(page, 'read')).value).toEqual(oldReceipt);
      expect((await call(page, 'switchOrdinary')).reason).toBe('conflict');
      expect((await call(page, 'replaceBeforeRetire')).reason).toBe('conflict');
      expect((await call(page, 'retire')).ok).toBe(true);
      const retired = (await call(page, 'read')).value;
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        (globalThis as any).restorePut = () => {
          IDBObjectStore.prototype.put = put;
        };
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'installation')
            throw new DOMException('synthetic quota after archive', 'QuotaExceededError');
          return Reflect.apply(put, this, args);
        };
      });
      try {
        expect((await call(page, 'replaceCandidate')).ok).toBe(false);
      } finally {
        await page.evaluate(() => (globalThis as any).restorePut());
      }
      expect((await call(page, 'read')).value).toEqual(retired);
      expect((await call(page, 'readOld')).value).toBe(null);
      expect((await call(page, 'replaceCandidate')).ok).toBe(true);
      expect((await call(page, 'replaceCandidate')).ok).toBe(true);
      expect((await call(page, 'readOld')).value).toEqual(retired);
      expect((await call(page, 'open')).ok).toBe(true);
      const replacement = (await call(page, 'read')).value;
      expect(replacement.binding.device).not.toBe(oldReceipt.binding.device);
      await stop(page);
      await boot(page, 'replacement', 'open-existing');
      expect((await call(page, 'status')).ok).toBe(false);
      expect(await call(page, 'journalRows')).toEqual(oldJournals);
      expect((await call(page, 'delete')).ok).toBe(true);
      await stop(page);
      await boot(page, 'replacement', 'open-existing', 1, true);
      expect((await call(page, 'status')).value).toBe('available');
      expect((await call(page, 'read')).value).toEqual(replacement);
      expect((await call(page, 'retire')).ok).toBe(true);
      const beforeReuse = await call(page, 'read');
      expect((await call(page, 'reuseArchived')).reason).toBe('conflict');
      expect(await call(page, 'read')).toEqual(beforeReuse);
      await stop(page);
      await boot(page, 'capacity', 'create-or-open', 0, false, 1);
      for (const action of ['prepare', 'create', 'journalSeed'])
        expect((await call(page, action)).ok).toBe(true);
      const bounded = await call(page, 'journalRows');
      expect((await call(page, 'distributionMore')).reason).toBe('capacity');
      expect(await call(page, 'journalRows')).toEqual(bounded);
      await stop(page);
      await peer.close();
      // Actual native promise settlement, rather than caller cancellation, owns the write lease and borrowed bytes.
      const closingPeer = await context.newPage();
      await closingPeer.goto(pathToFileURL(file).href);
      await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (globalThis as any).restoreEncrypt = () => {
          SubtleCrypto.prototype.encrypt = encrypt;
        };
        (globalThis as any).cryptoEntered = false;
        (globalThis as any).closeDone = false;
        SubtleCrypto.prototype.encrypt = async function (...args) {
          const result = await Reflect.apply(encrypt, this, args);
          if ((args[2] as Uint8Array).byteLength === 32) {
            (globalThis as any).borrowed = args[2];
            (globalThis as any).cryptoEntered = true;
            await new Promise<void>((resolve) => {
              (globalThis as any).releaseEncrypt = resolve;
            });
          }
          return result;
        };
      });
      await boot(page, 'closing-native');
      for (const action of ['prepare', 'create']) expect((await call(page, action)).ok).toBe(true);
      await boot(closingPeer, 'closing-native', 'open-existing');
      const writing = call(page, 'wrapSigning');
      await page.waitForFunction(() => (globalThis as any).cryptoEntered === true);
      const closing = stop(page).then(() =>
        page.evaluate(() => {
          (globalThis as any).closeDone = true;
        })
      );
      await page.waitForFunction(async () => {
        const r = await (globalThis as any).CustodyFixture.invoke('status');
        return r.reason === 'closed';
      });
      const heldName = await page.evaluate(async () => {
        const state = await navigator.locks.query();
        return state.held![0]!.name!;
      });
      const workerTry = () =>
        closingPeer.evaluate(
          (name) =>
            new Promise<boolean>((resolve, reject) => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    `onmessage=async event=>{try{const held=await navigator.locks.request(event.data,{mode:'exclusive',ifAvailable:true},lock=>!!lock);postMessage({held});}catch(e){postMessage({error:String(e)});}}`,
                  ],
                  { type: 'application/javascript' }
                )
              );
              const worker = new Worker(url);
              const dispose = () => {
                worker.terminate();
                URL.revokeObjectURL(url);
              };
              worker.onmessage = (e) => {
                dispose();
                if (e.data.error) reject(new Error(e.data.error));
                else resolve(e.data.held);
              };
              worker.onerror = (e) => {
                dispose();
                reject(new Error(e.message));
              };
              worker.postMessage(name);
            }),
          heldName
        );
      try {
        expect(await page.evaluate(() => (globalThis as any).closeDone)).toBe(false);
        expect(await page.evaluate(() => Array.from((globalThis as any).borrowed))).toEqual(
          Array.from(
            Uint8Array.from(
              '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'.match(/../g)!,
              (x) => parseInt(x, 16)
            )
          )
        );
        expect((await call(closingPeer, 'status')).reason).toBe('conflict');
        expect(await workerTry()).toBe(false);
      } finally {
        await page.evaluate(() => (globalThis as any).releaseEncrypt());
        await closing;
        await page.evaluate(() => (globalThis as any).restoreEncrypt());
      }
      const firstWrapped = await writing;
      expect(firstWrapped.ok).toBe(true);
      expect(await page.evaluate(() => Array.from((globalThis as any).borrowed))).toEqual(
        new Array(32).fill(0)
      );
      expect(await call(closingPeer, 'wrapSigning')).toEqual(firstWrapped);
      expect(await workerTry()).toBe(true);
      await stop(closingPeer);
      await closingPeer.close();
      // A process may disappear after all three originals committed but before the protected receipt/reply.
      await boot(page, 'unknown-install');
      for (const action of ['prepare', 'create']) expect((await call(page, action)).ok).toBe(true);
      const unknown = call(page, 'wrapOnlyAndHold').catch(() => undefined);
      await page.waitForFunction(() => (globalThis as any).wrappersCommitted === true);
      await context.close();
      await unknown;
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await boot(page, 'unknown-install', 'open-existing');
      expect((await call(page, 'read')).value.phase).toBe('prepared');
      expect((await call(page, 'identityOriginals')).value).toHaveLength(3);
      expect((await call(page, 'restoreProtected')).ok).toBe(true);
      expect((await call(page, 'open')).ok).toBe(true);
      await stop(page);
      // A lost KEK creation result with only durable intent cannot generate a second KEK on retry.
      await page.evaluate(() => {
        const generate = SubtleCrypto.prototype.generateKey;
        (globalThis as any).restoreGenerate = () => {
          SubtleCrypto.prototype.generateKey = generate;
        };
        SubtleCrypto.prototype.generateKey = async function (this: SubtleCrypto, ...args: any[]) {
          await Reflect.apply(generate, this, args);
          throw new DOMException('synthetic lost generated key', 'OperationError');
        } as any;
      });
      await boot(page, 'unknown-key');
      expect((await call(page, 'prepare')).ok).toBe(true);
      expect((await call(page, 'create')).ok).toBe(false);
      await stop(page);
      await page.evaluate(() => (globalThis as any).restoreGenerate());
      await boot(page, 'unknown-key', 'open-existing');
      expect((await call(page, 'status')).reason).toBe('indeterminate');
      expect((await call(page, 'create')).reason).toBe('indeterminate');
      await stop(page);
      await page.evaluate(() => {
        const get = IDBObjectStore.prototype.get;
        (globalThis as any).restoreGet = () => {
          IDBObjectStore.prototype.get = get;
        };
        IDBObjectStore.prototype.get = function (key) {
          return Reflect.apply(get, this, [this.name === 'keys' ? 'synthetic-null-readback' : key]);
        };
      });
      try {
        await boot(page, 'null-key-readback');
        expect((await call(page, 'prepare')).ok).toBe(true);
        expect((await call(page, 'create')).ok).toBe(false);
      } finally {
        await stop(page);
        await page.evaluate(() => (globalThis as any).restoreGet());
      }
      await boot(page, 'null-key-readback', 'open-existing');
      expect((await call(page, 'status')).reason).toBe('indeterminate');
      expect((await call(page, 'create')).reason).toBe('indeterminate');
      await stop(page);
      const emptyKeyCount = await page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const r = indexedDB.open('null-key-readback', 1);
            r.onerror = () => reject(r.error);
            r.onsuccess = () => {
              const db = r.result,
                tx = db.transaction('keys', 'readonly'),
                count = tx.objectStore('keys').count();
              count.onsuccess = () => resolve(count.result);
              tx.oncomplete = () => db.close();
            };
          })
      );
      expect(emptyKeyCount).toBe(0);
      for (const missing of ['installation', 'keys', 'markers', 'nonces'] as const) {
        const name = 'lost-half-' + missing;
        await boot(page, name);
        for (const action of ['prepare', 'create', 'protect'])
          expect((await call(page, action)).ok).toBe(true);
        await stop(page);
        await page.evaluate(
          ({ n, table }) =>
            new Promise<void>((resolve, reject) => {
              const req = indexedDB.open(n, 1);
              req.onerror = () => reject(req.error);
              req.onsuccess = () => {
                const db = req.result,
                  tx = db.transaction(table, 'readwrite');
                if (table === 'installation')
                  tx.objectStore(table).put({ version: 1, current: null }, 0);
                else tx.objectStore(table).clear();
                tx.oncomplete = () => {
                  db.close();
                  resolve();
                };
                tx.onabort = () => reject(tx.error);
              };
            }),
          { n: name, table: missing }
        );
        await boot(page, name, 'open-existing');
        expect((await call(page, 'status')).ok, missing).toBe(false);
        expect((await call(page, 'create')).ok, missing).toBe(false);
        expect((await call(page, 'prepare')).ok, missing).toBe(false);
        await stop(page);
      }
      for (const mismatch of ['account', 'workspace', 'genesis'] as const) {
        await expect(
          boot(page, 'custody', 'open-existing', 0, false, 10000, mismatch)
        ).rejects.toThrow();
        await stop(page);
      }
      await page.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
        (globalThis as any).restoreLocks = () => {
          if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
          else delete (navigator as any).locks;
        };
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
      });
      try {
        await expect(boot(page, 'custody', 'open-existing')).rejects.toThrow();
      } finally {
        await stop(page);
        await page.evaluate(() => (globalThis as any).restoreLocks());
      }
      await boot(page, 'custody', 'open-existing');
      expect(await call(page, 'read')).toEqual(ready);
      expect((await call(page, 'status')).value).toBe('available');
      await stop(page);
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

async function withCustodyBrowser(
  engine: 'chromium' | 'webkit',
  work: (page: Page, peer: Page) => Promise<void>
) {
  const output = await build({
    entryPoints: [fileURLToPath(new URL('./browser/custody-entry.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'CustodyFixture',
    target: 'safari16.4',
    write: false,
    logLevel: 'silent',
  });
  const dir = await mkdtemp(join(tmpdir(), 'lody-custody-recovery-'));
  let context: BrowserContext | undefined;
  try {
    const file = join(dir, 'index.html');
    await writeFile(
      file,
      '<!doctype html><script>' +
        output.outputFiles[0].text.replaceAll('</script', '<\\/script') +
        '</script>'
    );
    context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(
      join(dir, 'profile'),
      { headless: true }
    );
    const page = await context.newPage(),
      peer = await context.newPage();
    await page.goto(pathToFileURL(file).href);
    await peer.goto(pathToFileURL(file).href);
    await work(page, peer);
  } finally {
    await context?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

it.each(['chromium', 'webkit'] as const)(
  'refuses KEK recreation over prepared wrapping originals in %s',
  async (engine) => {
    await withCustodyBrowser(engine, async (page) => {
      await boot(page, 'residual-originals');
      for (const action of ['prepare', 'create', 'wrapOnly'])
        expect((await call(page, action)).ok).toBe(true);
      const receipt = await call(page, 'read'),
        originals = await call(page, 'identityOriginals');
      expect(originals.value).toHaveLength(3);
      await stop(page);
      await page.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.open('residual-originals', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result,
                tx = db.transaction(['keys', 'markers', 'nonces'], 'readwrite');
              for (const table of ['keys', 'markers', 'nonces']) tx.objectStore(table).clear();
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => {
                db.close();
                reject(tx.error);
              };
            };
          })
      );
      await boot(page, 'residual-originals', 'open-existing');
      const status = await call(page, 'status'),
        created = await call(page, 'create');
      expect(status.ok).toBe(false);
      expect(created.ok).toBe(false);
      expect(await call(page, 'read')).toEqual(receipt);
      expect(await call(page, 'identityOriginals')).toEqual(originals);
      const counts = await page.evaluate(
        () =>
          new Promise<number[]>((resolve, reject) => {
            const request = indexedDB.open('residual-originals', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result,
                names = ['keys', 'markers', 'nonces'],
                tx = db.transaction(names, 'readonly');
              const storedCounts: number[] = [];
              names.forEach((name, i) => {
                const count = tx.objectStore(name).count();
                count.onsuccess = () => {
                  storedCounts[i] = count.result;
                };
              });
              tx.oncomplete = () => {
                db.close();
                resolve(storedCounts);
              };
              tx.onabort = () => {
                db.close();
                reject(tx.error);
              };
            };
          })
      );
      expect(counts).toEqual([0, 0, 0]);
      await stop(page);
    });
  }
);

it.each(['chromium', 'webkit'] as const)(
  'does not lend inherited writer ownership to a child fiber in %s',
  async (engine) => {
    await withCustodyBrowser(engine, async (page, peer) => {
      await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (globalThis as any).cryptoEntered = false;
        (globalThis as any).holdEncrypt = true;
        SubtleCrypto.prototype.encrypt = async function (...args) {
          const result = await Reflect.apply(encrypt, this, args);
          if ((args[2] as Uint8Array).byteLength === 32 && (globalThis as any).holdEncrypt) {
            (globalThis as any).borrowed = args[2];
            (globalThis as any).cryptoEntered = true;
            (globalThis as any).notifyEntered();
            await new Promise<void>((resolve) => {
              (globalThis as any).releaseEncrypt = resolve;
            });
          }
          return result;
        };
      });
      await boot(page, 'forked-writer');
      for (const action of ['prepare', 'create']) expect((await call(page, action)).ok).toBe(true);
      await boot(peer, 'forked-writer', 'open-existing');
      const writing = call(page, 'forkWrap');
      await page.waitForFunction(() => (globalThis as any).outerReturned === true);
      let state: { entered: boolean; held: number }, peerStatus: any;
      try {
        state = await page.evaluate(async () => ({
          entered: (globalThis as any).cryptoEntered,
          held: (await navigator.locks.query()).held!.length,
        }));
        peerStatus = await call(peer, 'status');
      } finally {
        await page.evaluate(() => {
          (globalThis as any).holdEncrypt = false;
          (globalThis as any).releaseEncrypt?.();
        });
      }
      const result = await writing;
      // Child work must acquire its own physical lease instead of inheriting the parent's reentry token.
      expect(state.entered).toBe(false);
      expect(result).toEqual({ ok: false, reason: 'conflict' });
      expect(state.held).toBe(0);
      expect(peerStatus).toEqual({ ok: true, value: 'available' });
      expect((await call(page, 'identityOriginals')).value).toEqual([]);
      const nested = await call(page, 'nestedWrap');
      expect(nested.ok).toBe(true);
      expect(await call(page, 'wrapSigning')).toEqual(nested);
      await stop(page);
      await stop(peer);
    });
  }
);

it.each(['chromium', 'webkit'] as const)(
  'retries a quota failure before encryption without leaving an unknown intent in %s',
  async (engine) => {
    await withCustodyBrowser(engine, async (page) => {
      await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (globalThis as any).payloadEncryptions = 0;
        SubtleCrypto.prototype.encrypt = function (...args) {
          if ((args[2] as Uint8Array).byteLength === 32) (globalThis as any).payloadEncryptions++;
          return Reflect.apply(encrypt, this, args);
        };
      });
      await boot(page, 'preflight-quota');
      for (const action of ['prepare', 'create']) expect((await call(page, action)).ok).toBe(true);
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        let failed = false;
        IDBObjectStore.prototype.put = function (...args) {
          if (
            this.name === 'meta' &&
            args[1] === 'writable-probe' &&
            args[0]?.writable === true &&
            !failed
          ) {
            failed = true;
            throw new DOMException('synthetic quota before encryption', 'QuotaExceededError');
          }
          return Reflect.apply(put, this, args);
        };
        (globalThis as any).restorePut = () => {
          IDBObjectStore.prototype.put = put;
        };
      });
      try {
        expect((await call(page, 'wrapEpoch')).ok).toBe(false);
      } finally {
        await page.evaluate(() => (globalThis as any).restorePut());
      }
      expect(await page.evaluate(() => (globalThis as any).payloadEncryptions)).toBe(0);
      expect((await call(page, 'status')).value).toBe('available');
      const wrapped = await call(page, 'wrapEpoch');
      expect(wrapped.ok).toBe(true);
      expect(await call(page, 'wrapEpoch')).toEqual(wrapped);
      expect(await page.evaluate(() => (globalThis as any).payloadEncryptions)).toBe(1);
      await stop(page);
      await boot(page, 'preflight-quota', 'open-existing');
      expect(await call(page, 'wrapEpoch')).toEqual(wrapped);
      expect(await page.evaluate(() => (globalThis as any).payloadEncryptions)).toBe(1);
      await stop(page);
    });
  }
);
