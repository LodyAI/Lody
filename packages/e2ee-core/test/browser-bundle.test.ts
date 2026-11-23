import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { expect, it } from 'vitest';
import vector from './hpke-vector.json';

it.each(['chromium', 'webkit'] as const)(
  'bundles without Node and runs with unavailable native curves/WASM in %s',
  async (engine) => {
    const bundled = await build({
      entryPoints: [fileURLToPath(new URL('./browser/crypto-entry.ts', import.meta.url))],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'BrowserCryptoFixture',
      target: 'safari16.4',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    // The browser resolver rejects builtins. Also require a self-contained output,
    // so no runtime external import can hide an unbundled Node dependency.
    expect(Object.values(bundled.metafile!.outputs).flatMap((output) => output.imports)).toEqual(
      []
    );
    const directory = await mkdtemp(join(tmpdir(), 'lody-browser-crypto-'));
    const browser = await (engine === 'chromium' ? chromium : webkit).launch();
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(globalThis, 'WebAssembly', { value: undefined });
        const unsupported = () =>
          Promise.reject(new DOMException('unsupported', 'NotSupportedError'));
        const proto = SubtleCrypto.prototype;
        const nativeImport = proto.importKey;
        proto.importKey = function (this: SubtleCrypto, ...args: unknown[]) {
          const algorithm = args[2] as AlgorithmIdentifier;
          const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
          if (name === 'Ed25519' || name === 'X25519') return unsupported();
          return Reflect.apply(nativeImport, this, args);
        };
        const nativeDerive = proto.deriveBits;
        proto.deriveBits = function (...args) {
          if ((typeof args[0] === 'string' ? args[0] : args[0].name) === 'X25519')
            return unsupported();
          return Reflect.apply(nativeDerive, this, args);
        };
        const nativeSign = proto.sign;
        proto.sign = function (...args) {
          if ((typeof args[0] === 'string' ? args[0] : args[0].name) === 'Ed25519')
            return unsupported();
          return Reflect.apply(nativeSign, this, args);
        };
      });
      const file = join(directory, 'index.html');
      await writeFile(
        file,
        '<!doctype html><meta charset="utf-8"><script>' +
          bundled.outputFiles[0]!.text.replaceAll('</script', '<\\/script') +
          '</script>'
      );
      await page.goto(pathToFileURL(file).href);
      const result = await page.evaluate(() =>
        (
          globalThis as unknown as {
            BrowserCryptoFixture: { runBrowserCrypto(): Promise<unknown> };
          }
        ).BrowserCryptoFixture.runBrowserCrypto()
      );
      expect(result).toEqual({
        wasm: false,
        signatureValid: true,
        original: vector.epoch.pt,
        roundtrip: vector.epoch.pt,
        wrongAadRejected: true,
      });
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
