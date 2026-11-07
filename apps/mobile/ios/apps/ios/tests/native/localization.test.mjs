import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('String Catalog checks accept reordered arguments and reject broken translations and missing keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-localization-'));
  const app = path.join(root, 'apps/ios');
  const kit = path.join(root, 'packages/LodyKit/Sources/LodyKit');
  const entry = (en, zh = en) => ({
    localizations: Object.fromEntries(
      [
        ['en', en],
        ['zh-Hans', zh],
      ].map(([language, value]) => [
        language,
        { stringUnit: { state: 'translated', value } },
      ]),
    ),
  });
  const catalog = path.join(kit, 'Resources/Localizable.xcstrings');
  const save = (file, strings) =>
    writeFile(
      file,
      JSON.stringify({ sourceLanguage: 'en', strings, version: '1.0' }),
    );
  const run = () =>
    spawnSync(process.execPath, [path.join(app, 'scripts/check-locales.mjs')], {
      encoding: 'utf8',
    });
  try {
    for (const directory of [
      path.join(app, 'scripts'),
      path.join(app, 'App'),
      path.join(app, 'Extensions'),
      path.dirname(catalog),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await copyFile(
      new URL('../../scripts/check-locales.mjs', import.meta.url),
      path.join(app, 'scripts/check-locales.mjs'),
    );
    await save(
      path.join(app, 'App/InfoPlist.xcstrings'),
      Object.fromEntries(
        [
          'CFBundleDisplayName',
          'NSCameraUsageDescription',
          'NSLocalNetworkUsageDescription',
          'NSPhotoLibraryUsageDescription',
        ].map((key) => [key, entry('Prompt')]),
      ),
    );
    await writeFile(
      path.join(kit, 'Copy.swift'),
      'let title = String(localized: "summary", bundle: .lody)',
    );
    await save(catalog, {
      summary: entry('%1$@ / %2$@ (100%%)', '%2$@ / %1$@ (100%%)'),
    });
    let result = run();
    assert.equal(result.status, 0, result.stderr);

    await save(catalog, { summary: entry('%1$@', '%1$lld') });
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incompatible format arguments/);

    const untranslated = entry('Hello');
    delete untranslated.localizations['zh-Hans'];
    await save(catalog, { summary: untranslated });
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /needs English and Simplified Chinese/);

    await save(catalog, {});
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing catalog key summary/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
