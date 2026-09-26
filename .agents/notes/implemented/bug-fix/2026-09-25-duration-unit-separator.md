# Localize the duration unit separator

Status: implemented
Translation: current

[中文](2026-09-25-duration-unit-separator.zh.md)

## Abstract

`formatDurationCompact` joined unit groups with a hardcoded ASCII space, so zh-CN
durations rendered as "43分 32秒" — a space between 分 and 秒 that reads loose and
non-native in Chinese typography. The join is now a localized `time.unitSeparator`
value: English keeps " ", Chinese ships "". A shared `getDurationUnitLabels(t)`
builder in `lib/format-duration.ts` builds the units plus separator so no caller
can leak the Latin spacing again. zh renders "工作了 43分32秒"; English output is
unchanged.

## Problem and evidence

The activity rows in a running turn (`view.tsx`'s live group label, via
`LiveActivityLabel` / `sessions.activityWithDuration`) showed "调用了 1 个命令（工作
了 2分 01秒）". The space inside "2分 01秒" is what made the duration read as two
loose fragments. The same join fed every duration surface: worked-group headers,
turn footers, goal banner metrics, PR CI run times, and subagent task rows —
each constructing the same three-field `DurationUnitLabels` object inline.

## Approach

- `DurationUnitLabels` gains an optional `separator` (default `' '`), applied
  between the h/m/s groups inside `formatDurationCompact`.
- New `getDurationUnitLabels(t)` helper returns the three units plus
  `separator: t('time.unitSeparator', ' ')`; all seven inline constructions now
  use it, so the separator cannot be forgotten.
- Locales: `en` ships `" "` (unchanged output), `zh_CN` ships `""`. i18next's
  `returnEmptyString` default passes the empty value through, and the key-presence
  checker (`lint:i18n`) is satisfied by both files.

Alternatives considered: detecting CJK inside the unit strings (a hidden heuristic,
and the unit text is not where a typography rule belongs), or per-arity i18n
templates (correct word order control, but three keys and more interpolation for
no practical gain at two shipped locales).

## Limits

The separator only covers the h/m/s chain; the surrounding templates (e.g.
"工作了 {{duration}}") keep their own CJK–digit spacing. Single-unit labels in
`session-info-chips.tsx` never join and are unaffected. Verified by a Node
strip-types smoke run of the formatter (en "43m 32s", zh "43分32秒", missing
separator falls back to " ") and `lint:i18n`; full `pnpm check` was not run in
this nested worktree (no installed node_modules).
