import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { setAppIcon } from './set-app-icon.mjs';

for (const platform of ['ios', 'android']) {
  test(`${platform}: nightly generates usable icons and stable restores native configuration`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lody-mobile-icons-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const relative =
      platform === 'ios'
        ? 'ios/App/App.xcodeproj/project.pbxproj'
        : 'android/app/src/main/AndroidManifest.xml';
    const source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
    const configPath = join(root, relative);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, source);
    await setAppIcon(platform, 'stable', root);
    const original = await readFile(configPath, 'utf8');

    await setAppIcon(platform, 'nightly', root);
    const nightly = await readFile(configPath, 'utf8');
    assert.notEqual(nightly, original);
    if (platform === 'ios') {
      const catalog = join(root, 'ios/App/App/Assets.xcassets/AppIconNightly.appiconset');
      const contents = JSON.parse(await readFile(join(catalog, 'Contents.json'), 'utf8'));
      const metadata = await sharp(join(catalog, contents.images[0].filename)).metadata();
      assert.equal(metadata.width, 1024);
      assert.equal(metadata.hasAlpha, false);
      assert.equal(
        nightly.match(/ASSETCATALOG_COMPILER_APPICON_NAME = AppIconNightly;/g).length,
        2
      );
    } else {
      for (const [density, size] of [
        ['mdpi', 48],
        ['hdpi', 72],
        ['xhdpi', 96],
        ['xxhdpi', 144],
        ['xxxhdpi', 192],
      ]) {
        const directory = join(root, `android/app/src/main/res/mipmap-${density}`);
        const legacy = await sharp(join(directory, 'ic_launcher_nightly.png')).metadata();
        const adaptive = await sharp(
          join(directory, 'ic_launcher_nightly_foreground.png')
        ).metadata();
        assert.equal(legacy.width, size);
        assert.equal(adaptive.width, size * 2.25);
      }
      assert.ok(nightly.includes('android:icon="@mipmap/ic_launcher_nightly"'));
      assert.ok(nightly.includes('android:roundIcon="@mipmap/ic_launcher_nightly"'));
      const xml = await readFile(
        join(root, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_nightly.xml'),
        'utf8'
      );
      assert.ok(xml.includes('@mipmap/ic_launcher_nightly_foreground'));
    }
    const preview = await sharp(join(root, 'src/assets/app-icon-nightly.png')).metadata();
    assert.equal(preview.width, 128);

    // Preserve edits made after selecting Nightly, including unrelated native settings.
    await writeFile(configPath, nightly + '\n');
    await setAppIcon(platform, 'stable', root);
    assert.equal(await readFile(configPath, 'utf8'), original + '\n');
    await setAppIcon(platform, 'stable', root);
    assert.equal(await readFile(configPath, 'utf8'), original + '\n');
  });
}

test('invalid platform/channel fail before touching native files', async () => {
  await assert.rejects(setAppIcon('web', 'nightly'), /Usage:/);
  await assert.rejects(setAppIcon('ios', 'production'), /Usage:/);
});
