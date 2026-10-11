# Evergreen static Claude model labels

Status: implemented
Translation: current

English | [中文](2026-10-11-claude-static-labels-evergreen.zh.md)

## Abstract

The provisional first-render Claude model labels in `packages/shared/src/ai.ts` hardcoded minor versions (`Haiku 4.5`, `Sonnet 5`, `Opus 5`, `Fable 5.1`) snapshotted against Claude Code 2.1.258, while runtime-only bumps (#906, #1103) moved the manifest to 2.1.284 without syncing them. This change drops the hardcoded versions from the static descriptions so they cannot go stale between runtime upgrades. Exact versions remain visible from the live ACP runtime probe, which rewrites labels per model. A contract test now rejects version-like strings in static Claude model labels.

## Evidence

- Static source `packages/shared/src/ai.ts:931` (`CLAUDE_STATIC_MODELS`); UI uses it only when no machine capability cache exists (`packages/components/src/components/shared/acp-selector-options.ts:227`, authority `provisional`).
- The pinned adapter passes SDK-advertised models through instead of hardcoding them, so the probe already supplies exact versions after each capability refresh.
- Aliases (`haiku` / `sonnet` / `opus`) resolve server-side, so a version-free static label never misroutes.

## Alternatives considered

- Keep syncing versions in the static table on every runtime bump: rejected, because #906/#1103 prove the sync is routinely skipped, recreating the same stale-label gap.
- Show no description at all: rejected, the family + trait copy (`Fastest for quick answers`) still helps first-render selection.

## Trade-offs

- First render loses specificity (no version number until the runtime probe lands). Accepted: the probe lands on the same session start path and carries authoritative labels.

## Verification limits

- Edited `ai-claude.test.ts` expectations plus a new no-hardcoded-version assertion; the full suite could not run in this checkout (no dependency install), so CI must confirm. `pnpm check` / `pnpm format` likewise pending CI.
