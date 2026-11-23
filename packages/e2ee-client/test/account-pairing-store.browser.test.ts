type ContractGlobal = typeof globalThis & {
  AccountPairingStoreFixture: typeof import('./browser/account-pairing-store-fixture');
};
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

it.each(['chromium', 'webkit'] as const)(
  'keeps the account pairing store contract on real IndexedDB in %s',
  async (engine) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-account-pairing-store-'));
    const browser = await (engine === 'chromium' ? chromium : webkit).launch();
    try {
      const output = await build({
        entryPoints: [
          fileURLToPath(new URL('./browser/account-pairing-store-fixture.ts', import.meta.url)),
        ],
        platform: 'browser',
        bundle: true,
        format: 'iife',
        globalName: 'AccountPairingStoreFixture',
        target: 'safari16.4',
        write: false,
        logLevel: 'silent',
      });
      await writeFile(join(dir, 'fixture.js'), output.outputFiles[0]!.text);
      await writeFile(join(dir, 'index.html'), '<script src="fixture.js"></script>');
      const page = await browser.newPage();
      await page.goto(pathToFileURL(join(dir, 'index.html')).href);
      const failures = await page.evaluate(() =>
        (globalThis as ContractGlobal).AccountPairingStoreFixture.runContract()
      );
      expect(failures).toEqual([]);
      expect(
        await page.evaluate(() =>
          (globalThis as ContractGlobal).AccountPairingStoreFixture.persists()
        )
      ).toBe('declined');
      expect(
        await page.evaluate(() =>
          (globalThis as ContractGlobal).AccountPairingStoreFixture.refusesWrongLayout()
        )
      ).toEqual([]);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);
