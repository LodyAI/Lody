type StoreGlobal = typeof globalThis & {
  StoreFixture: typeof import('./browser/store-fixture');
  restorePut: () => void;
};
import { build } from 'esbuild';
import { chromium, webkit, type BrowserContext, type Page } from '@playwright/test';
import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const call = (page: Page, action: string) =>
  page.evaluate((a) => (globalThis as StoreGlobal).StoreFixture.invoke(a), action);
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
  'retains RPC originals and atomic paged approval evidence across %s process reopen',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-personal-rpc-'));
    let context: BrowserContext | undefined;
    try {
      const output = await build({
        entryPoints: [fileURLToPath(new URL('./browser/store-fixture.ts', import.meta.url))],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'StoreFixture',
        target: 'safari16.4',
        write: false,
        metafile: true,
        logLevel: 'silent',
      });
      expect(Object.values(output.metafile!.outputs).flatMap((o) => o.imports)).toEqual([]);
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
      await page.evaluate(() => (globalThis as StoreGlobal).StoreFixture.boot());
      expect(await call(page, 'large')).toEqual({ ok: true, value: 2 * 1024 * 1024 });
      expect((await call(page, 'first')).value).toEqual([1, 2]);
      expect((await call(page, 'changed')).value).toEqual([1, 2]);
      expect((await call(page, 'incoming')).ok).toBe(true);
      expect((await call(page, 'incomingChanged')).reason).toBe('conflict');
      expect((await call(page, 'seedConflict')).ok).toBe(true);
      expect((await call(page, 'batchConflict')).reason).toBe('conflict');
      expect(record(await call(page, 'rows')).conflict).toEqual([null, [7]]);
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        let failed = false;
        IDBObjectStore.prototype.put = function (...args) {
          if (
            this.name === 'data' &&
            (args[0] as Record<string, unknown>).key === 'quota' &&
            (args[0] as Record<string, unknown>).sequence === 1 &&
            !failed
          ) {
            failed = true;
            throw new DOMException('synthetic quota after first page', 'QuotaExceededError');
          }
          return Reflect.apply(put, this, args);
        };
        (globalThis as StoreGlobal).restorePut = () => {
          IDBObjectStore.prototype.put = put;
        };
      });
      try {
        expect((await call(page, 'batchQuota')).reason).toBe('capacity');
      } finally {
        await page.evaluate(() => (globalThis as StoreGlobal).restorePut());
      }
      expect(record(await call(page, 'rows')).quota).toEqual([null, null]);
      expect((await call(page, 'batchQuota')).ok).toBe(true);
      expect((await call(page, 'proof')).value).toEqual([[1, 2], [3]]);
      expect((await call(page, 'proofChanged')).reason).toBe('conflict');
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        let failed = false;
        IDBObjectStore.prototype.put = function (...args) {
          if (
            this.name === 'data' &&
            (args[0] as Record<string, unknown>).session === 'bb'.repeat(16) &&
            (args[0] as Record<string, unknown>).index === 1 &&
            !failed
          ) {
            failed = true;
            throw new DOMException('quota after first approval page', 'QuotaExceededError');
          }
          return Reflect.apply(put, this, args);
        };
        (globalThis as StoreGlobal).restorePut = () => {
          IDBObjectStore.prototype.put = put;
        };
      });
      try {
        expect((await call(page, 'proofQuota')).reason).toBe('capacity');
      } finally {
        await page.evaluate(() => (globalThis as StoreGlobal).restorePut());
      }
      expect((await call(page, 'proofRows')).value).toEqual({ first: [[1, 2], [3]], quota: null });
      expect((await call(page, 'proofQuota')).ok).toBe(true);
      const proofs = await call(page, 'proofRows');
      const rows = await call(page, 'rows');
      await page.evaluate(() => (globalThis as StoreGlobal).StoreFixture.stop());
      await context.close();
      context = await browser.launchPersistentContext(join(dir, 'profile'), { headless: true });
      page = await context.newPage();
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => (globalThis as StoreGlobal).StoreFixture.boot('open-existing'));
      expect(await call(page, 'largeRead')).toEqual({ ok: true, value: 2 * 1024 * 1024 });
      expect(await call(page, 'rows')).toEqual(rows);
      expect(await call(page, 'proofRows')).toEqual(proofs);
      expect((await call(page, 'corruptProof')).ok).toBe(true);
      expect((await call(page, 'proofRows')).reason).toBe('corrupt');
      expect((await call(page, 'proof')).reason).toBe('corrupt');
      expect((await call(page, 'proofRows')).reason).toBe('corrupt');
      expect((await call(page, 'close')).ok).toBe(true);
      expect((await call(page, 'largeRead')).reason).toBe('closed');
      await page.evaluate(() => (globalThis as StoreGlobal).StoreFixture.stop());
    } finally {
      await context?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);
