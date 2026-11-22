import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const mobileRoot = fileURLToPath(new URL('../', import.meta.url));
const nightlySource = fileURLToPath(
  new URL('../../../apps/electron/resources/icon-nightly.png', import.meta.url)
);

// Change only the icon selectors, preserving local Xcode/manifest edits.
export async function setAppIcon(platform, channel, root = mobileRoot, source = nightlySource) {
  if (!['ios', 'android'].includes(platform) || !['stable', 'nightly'].includes(channel)) {
    throw new Error('Usage: node scripts/set-app-icon.mjs <ios|android> <stable|nightly>');
  }
  const nightly = channel === 'nightly';
  const configPath = join(
    root,
    platform === 'ios'
      ? 'ios/App/App.xcodeproj/project.pbxproj'
      : 'android/app/src/main/AndroidManifest.xml'
  );
  const config = await readFile(configPath, 'utf8');
  let next;
  if (platform === 'ios') {
    const pattern = /ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon(?:Nightly)?;/g;
    if (!pattern.test(config)) throw new Error('Missing iOS app icon selector');
    next = config.replace(
      pattern,
      `ASSETCATALOG_COMPILER_APPICON_NAME = ${nightly ? 'AppIconNightly' : 'AppIcon'};`
    );
  } else {
    next = config;
    for (const [attribute, stableName] of [
      ['icon', 'ic_launcher'],
      ['roundIcon', 'ic_launcher_round'],
    ]) {
      const pattern = new RegExp(
        `android:${attribute}="@mipmap/(?:${stableName}|ic_launcher_nightly)"`
      );
      if (!pattern.test(next)) throw new Error(`Missing Android ${attribute} selector`);
      next = next.replace(
        pattern,
        `android:${attribute}="@mipmap/${nightly ? 'ic_launcher_nightly' : stableName}"`
      );
    }
  }

  if (nightly) {
    const png = await sharp(source)
      .flatten({ background: '#101010' })
      .resize(1024, 1024)
      .png()
      .toBuffer();
    const write = async (path, data) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    };
    await write(
      'src/assets/app-icon-nightly.png',
      await sharp(png).resize(128, 128).png().toBuffer()
    );
    if (platform === 'ios') {
      const directory = 'ios/App/App/Assets.xcassets/AppIconNightly.appiconset';
      await write(`${directory}/icon.png`, png);
      await write(
        `${directory}/Contents.json`,
        JSON.stringify(
          {
            images: [
              { filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
            ],
            info: { author: 'xcode', version: 1 },
          },
          null,
          2
        ) + '\n'
      );
    } else {
      const res = 'android/app/src/main/res';
      for (const [density, size] of [
        ['mdpi', 48],
        ['hdpi', 72],
        ['xhdpi', 96],
        ['xxhdpi', 144],
        ['xxxhdpi', 192],
      ]) {
        await write(
          `${res}/mipmap-${density}/ic_launcher_nightly.png`,
          await sharp(png).resize(size, size).png().toBuffer()
        );
        // Adaptive icons use a 108dp canvas with artwork inside the central 72dp.
        const foreground = size * 1.5;
        const padding = size * 0.375;
        await write(
          `${res}/mipmap-${density}/ic_launcher_nightly_foreground.png`,
          await sharp(png)
            .resize(foreground, foreground)
            .extend({
              top: padding,
              bottom: padding,
              left: padding,
              right: padding,
              background: '#101010',
            })
            .png()
            .toBuffer()
        );
      }
      await write(
        `${res}/mipmap-anydpi-v26/ic_launcher_nightly.xml`,
        `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@android:color/black"/>
    <foreground android:drawable="@mipmap/ic_launcher_nightly_foreground"/>
</adaptive-icon>
`
      );
    }
  }
  if (next !== config) await writeFile(configPath, next);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await setAppIcon(process.argv[2], process.argv[3]);
}
