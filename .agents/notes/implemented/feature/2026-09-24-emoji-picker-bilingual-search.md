# Emoji picker searches both bundled languages

Status: implemented
Translation: current

[中文](2026-09-24-emoji-picker-bilingual-search.zh.md)

## Abstract

The Agent Role emoji picker loads a single emojibase locale that follows the
product language, and frimousse only searches that dataset's `label` and
`tags` — so a Chinese UI could not find 🔍 by typing "magnifying", and an
English UI could not find it by typing "放大镜". The Vite plugin that already
emits the bundled dataset now folds every other bundled locale's `label` and
`tags` into each emoji's `tags` (keyed on `hexcode`), so one query matches in
either product language while displayed names and category headers stay in the
UI language. The one real limit: frimousse matches the whole trimmed query
with `includes`, so a single query mixing both languages still finds nothing —
"either language" works, "both at once" does not.

## Decision

- `vite-emojibase-assets.ts` no longer copies `data.json` verbatim. For each
  bundled locale it reads all bundled locales, builds `hexcode → label + tags`
  from the other locales, and appends that text (deduplicated) to each emoji's
  `tags`. `label` and `messages.json` are untouched, so the picker keeps
  showing the UI language.
- The foreign `label` is folded in explicitly, not just foreign `tags`:
  emojibase tags do not always contain the label's words (the English tag
  "magnify" does not include the query "magnifying").
- The asset contract changed from `{ fileName, sourcePath }` to
  `{ fileName, read() }` so generated JSON and verbatim files (`messages.json`)
  share one path through `emitFile` and the dev middleware. Merged output is
  memoized, so dev requests and the build emit share one generation pass.
- Ranking consequence is acceptable and arguably desirable: a foreign-language
  hit scores +1 per tag while a native `label` hit scores +10, so
  native-language matches still rank first.

## Alternatives considered

- Loading both locales at runtime: frimousse 0.3.0 accepts a single `locale`
  and fetches `data.json`/`messages.json` itself; there is no data-injection or
  custom-search hook, so runtime merging would require forking the library.
- Upstream multi-locale support: none exists; upstream also does not load the
  separate shortcodes dataset (liveblocks/frimousse#2, #9), so a locale union
  is unlikely to arrive soon.
- Keeping the verbatim copy and translating queries through an alias table:
  rejected — a second hand-maintained dictionary drifts from emojibase, while
  the merge reuses data already shipped.

## Verification

- `tests/emojibase-assets.test.ts` now simulates frimousse's matching
  (lowercased `includes` over `label` then `tags`) against the generated
  `zh`/`en` data: "magnifying" matches in the zh dataset and "放大镜" in the
  en dataset, and `1F50D` keeps a Chinese `label` in zh and the English
  `label` in en — proving only `tags` merged.
- `NODE_ENV=test vitest run tests/emojibase-assets.test.ts`: 5 tests pass;
  `tsgo --noEmit`, `oxfmt --check`, and `oxlint` are clean on touched files.
- Cost stays bounded: the merge runs once per emitted locale at build/dev-serve
  time; measured output is 843 KB (zh) / 860 KB (en) versus ~750 KB verbatim,
  and search remains a few short-string `includes` per emoji per keystroke.

## Limits

- Whole-query `includes` means mixed-language single queries ("放 glass")
  match nothing; supporting that needs per-word matching frimousse does not
  do.
- Only the bundled locales (`en`, `zh`) participate; a product language mapped
  onto `en` still cannot search in that language.
