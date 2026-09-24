import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { EMOJIBASE_ASSET_DIRECTORY, EMOJIBASE_BUNDLED_LOCALES } from './src/lib/emojibase-assets';

/**
 * Ships the emoji picker's dataset with the app instead of fetching it.
 *
 * `frimousse` resolves its data as `${emojibaseUrl}/${locale}/{data,messages}.json`
 * and defaults that base to a public CDN. Lody's desktop and mobile apps are
 * local-first and are expected to work with no network at all, where that
 * default leaves the picker spinning forever — so every host build emits those
 * files itself and points the picker at them.
 *
 * It is a URL contract, not an import: the library builds those paths at
 * runtime, so a bundled `?url` asset (whose name is hashed) cannot satisfy it.
 * Hence a plugin that writes a real directory into the build output and serves
 * the same paths in dev.
 *
 * `data.json` is not emitted verbatim: each locale's copy carries every OTHER
 * bundled locale's `label` and `tags` folded into its `tags`. frimousse loads
 * a single locale and scores matches against `label` and `tags` only, so this
 * lets one query match in either product language — "放大镜" and "magnifying"
 * both find 🔍 — while displayed names and category headers keep the UI
 * language. The foreign label must go in explicitly: tags do not always
 * contain the label's words ("magnify" does not include "magnifying").
 */

type EmojibaseDataEntry = {
  hexcode?: unknown;
  label?: unknown;
  tags?: unknown;
};

export type EmojibaseAsset = {
  /** Output path, relative to the build's asset root. */
  fileName: string;
  /** The bytes to emit or serve — a verbatim dataset file or generated JSON. */
  read: () => Promise<Buffer>;
};

const tagList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];

const readDataJson = async (packageRoot: string, locale: string): Promise<EmojibaseDataEntry[]> => {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(packageRoot, locale, 'data.json'), 'utf8')
  );
  return Array.isArray(parsed) ? parsed : [];
};

const mergeLocaleData = async (packageRoot: string, locale: string): Promise<Buffer> => {
  const [own, ...rest] = await Promise.all(
    [locale, ...EMOJIBASE_BUNDLED_LOCALES.filter((other) => other !== locale)].map((other) =>
      readDataJson(packageRoot, other)
    )
  );

  const extraTagsByHexcode = new Map<string, string[]>();
  for (const data of rest) {
    for (const entry of data) {
      if (typeof entry?.hexcode !== 'string') continue;
      const texts = [
        ...(typeof entry.label === 'string' ? [entry.label] : []),
        ...tagList(entry.tags),
      ];
      const existing = extraTagsByHexcode.get(entry.hexcode);
      if (existing) existing.push(...texts);
      else extraTagsByHexcode.set(entry.hexcode, texts);
    }
  }

  const merged = own.map((entry) => {
    const extra =
      typeof entry?.hexcode === 'string' ? extraTagsByHexcode.get(entry.hexcode) : undefined;
    if (!extra?.length) return entry;
    return { ...entry, tags: [...new Set([...tagList(entry.tags), ...extra])] };
  });

  return Buffer.from(JSON.stringify(merged));
};

/**
 * Every file the picker can ask for, resolved through `emojibase-data`'s own
 * module resolution so the plugin cannot drift from the installed version.
 * Merged files are generated lazily and memoized, so dev-server requests and
 * the build emit share one pass.
 */
export function buildEmojibaseAssets(resolveFrom: string = import.meta.url): EmojibaseAsset[] {
  const require = createRequire(resolveFrom);
  const packageJsonPath = require.resolve('emojibase-data/package.json');
  const packageRoot = path.dirname(packageJsonPath);

  const mergedData = new Map<string, Promise<Buffer>>();
  const readMergedData = (locale: string): Promise<Buffer> => {
    let pending = mergedData.get(locale);
    if (!pending) {
      pending = mergeLocaleData(packageRoot, locale);
      mergedData.set(locale, pending);
    }
    return pending;
  };

  return EMOJIBASE_BUNDLED_LOCALES.flatMap((locale) => [
    {
      fileName: `${EMOJIBASE_ASSET_DIRECTORY}/${locale}/data.json`,
      read: () => readMergedData(locale),
    },
    {
      fileName: `${EMOJIBASE_ASSET_DIRECTORY}/${locale}/messages.json`,
      read: () => readFile(path.join(packageRoot, locale, 'messages.json')),
    },
  ]);
}

export function emojibaseAssetsPlugin(): Plugin {
  const assets = buildEmojibaseAssets();
  const byUrlPath = new Map(assets.map((asset) => [`/${asset.fileName}`, asset]));
  let isServing = false;

  return {
    name: 'lody-emojibase-assets',
    configResolved(config) {
      isServing = config.command === 'serve';
    },
    async buildStart() {
      // The dev server has no bundle to emit into — it serves the same paths
      // through the middleware below — and calling `emitFile` there only logs
      // "not supported in serve mode" on every reload.
      if (isServing) return;
      // Emitted with an explicit `fileName` so the locale directory survives
      // into the output; a hashed asset name would not match the URL the
      // picker builds.
      await Promise.all(
        assets.map(async (asset) =>
          this.emitFile({
            type: 'asset',
            fileName: asset.fileName,
            source: await asset.read(),
          })
        )
      );
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split('?')[0];
        const asset = requestPath ? byUrlPath.get(requestPath) : undefined;
        if (!asset) {
          next();
          return;
        }
        void asset.read().then(
          (contents) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(contents);
          },
          () => next()
        );
      });
    },
  };
}
