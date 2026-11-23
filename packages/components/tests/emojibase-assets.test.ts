// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { buildEmojibaseAssets } from '../vite-emojibase-assets';
import { getBundledEmojibaseUrl, resolveEmojibaseLocale } from '../src/lib/emojibase-assets';

type DataEntry = { hexcode: string; label: string; tags?: string[] };

const readAssetJson = async (fileName: string): Promise<DataEntry[]> => {
  const asset = buildEmojibaseAssets().find((a) => a.fileName === fileName);
  expect(asset, fileName).toBeTruthy();
  return JSON.parse((await asset!.read()).toString('utf8'));
};

/** frimousse's matching: query `includes` against label, then each tag. */
const searchMatches = (data: DataEntry[], query: string): DataEntry[] => {
  const q = query.toLowerCase().trim();
  return data.filter(
    (entry) =>
      entry.label.toLowerCase().includes(q) ||
      (entry.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
  );
};

describe('bundled emojibase assets', () => {
  it('emits exactly the files the picker asks for, per product language', () => {
    expect(buildEmojibaseAssets().map((asset) => asset.fileName)).toEqual([
      'emojibase/en/data.json',
      'emojibase/en/messages.json',
      'emojibase/zh/data.json',
      'emojibase/zh/messages.json',
    ]);
  });

  it('resolves every emitted file to parseable JSON', async () => {
    // The URL contract is only as good as the files behind it: a renamed or
    // missing dataset would otherwise surface as an empty picker at runtime.
    for (const asset of buildEmojibaseAssets()) {
      expect(JSON.parse((await asset.read()).toString('utf8'))).toBeTruthy();
    }
  });

  it('folds the other bundled locale into tags so search matches either language', async () => {
    const [zh, en] = await Promise.all([
      readAssetJson('emojibase/zh/data.json'),
      readAssetJson('emojibase/en/data.json'),
    ]);

    // A Chinese-locale picker answers an English query and vice versa —
    // frimousse only ever searches the one loaded dataset.
    expect(searchMatches(zh, 'magnifying').length).toBeGreaterThan(0);
    expect(searchMatches(en, '放大镜').length).toBeGreaterThan(0);

    // Displayed names stay in the picker's own language: only `tags` merged.
    const zhMagnifier = zh.find((entry) => entry.hexcode === '1F50D');
    expect(zhMagnifier?.label).toMatch(/\p{Script=Han}/u);
    const enMagnifier = en.find((entry) => entry.hexcode === '1F50D');
    expect(enMagnifier?.label).toBe('magnifying glass tilted left');
  });

  it('maps a product language onto a bundled locale, never an unbundled one', () => {
    expect(resolveEmojibaseLocale('en')).toBe('en');
    expect(resolveEmojibaseLocale('zh_CN')).toBe('zh');
    expect(resolveEmojibaseLocale('zh-Hans')).toBe('zh');
    // A language the picker has no bundled dataset for reads the English one
    // rather than requesting a file that was never emitted.
    expect(resolveEmojibaseLocale('ja')).toBe('en');
    expect(resolveEmojibaseLocale(undefined)).toBe('en');
  });

  it('anchors the dataset URL on the app root, not on the current route', () => {
    // The router uses browser history over http, so the document URL is a deep
    // route. Resolving against it asked for `…/settings/emojibase`, which the
    // dev server answered with the SPA fallback — the picker then parsed HTML
    // as JSON and gave up.
    window.history.pushState({}, '', '/acme/settings/agent-roles');
    expect(getBundledEmojibaseUrl()).toBe(`${window.location.origin}/emojibase`);

    window.history.pushState({}, '', '/');
    expect(getBundledEmojibaseUrl()).toBe(`${window.location.origin}/emojibase`);
  });
});
