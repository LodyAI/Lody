# Preserve literal punctuation in session search

Status: implemented
Translation: current

PR: [#1283](https://github.com/LodyAI/Lody/pull/1283)

[中文版](2026-10-07-session-search-literal-punctuation.zh.md)

## Abstract

Session search removed literal underscores from assistant prose and code, so
identifiers visible in a reply were absent from its index while an invented
identifier without underscores produced a count without a highlight. Search now
extracts CommonMark/GFM text with the renderer's parser family, preserving code
and literal punctuation and stripping parsed formatting delimiters. During a
nonempty search, streaming replies render their complete current text so marks
and results update together; clearing search restores the reveal animation.
Synthetic DOM and Chromium regressions cover these behaviors. The reported
production build's mapping to this source and native packaged rendering remain
unverified.

## Cause and decision

At source baseline `72b118b584133edb66d2b4bbec1173c1a7d4a2a0`,
`getSearchableMarkdownText` unconditionally removed stars, underscores and tildes
from the entire assistant string, including extracted code. User text bypassed
that conversion. `MarkdownRenderer` independently matched DOM text, creating the
observed disagreement. Synthetic user `QA_RESUMED_OK` and assistant
`QA_RESUMED_OK —` reproduce all three reported counts, including after reload.
The reported About build `0.103.0 / 092d1413` is evidence supplied by the reporter,
not a verified deployment mapping.

Use the already locked `unified` and `remark-parse` versions as direct dependencies
with existing `remark-gfm`. Extract text/code values from the syntax tree; retain
inline continuity across emphasis, and separate block containers with newlines.
This also handles escaped punctuation, entities, variable-length code spans,
tilde fences and unclosed fences. A delimiter regex cannot reliably distinguish
intraword underscores, emphasis and code. Normalizing the user's query would
retain phantom matches and change literal-search semantics.

The actual streaming renderer revealed another timing gap: its delayed text
reveal can miss marks installed by the parent's effect. Nonempty search uses
static Markdown over the current text; query clearing remounts the stream with
its existing `animateOnMount={false}` behavior. This pauses fade-in while searching
and avoids an observer or repeated DOM mutation during animated reveal. Search
marks still preserve React-owned text nodes under the
[existing DOM ownership decision](2026-09-27-search-marks-keep-react-text.md).

The prose-only extraction boundary is unchanged. Tool titles, payloads, terminal
logs, diffs and structured status remain excluded. The outline still slices its
source to 960 characters before parsing and caches digests by message/row object;
search retains its per-turn cache, frame coalescing and open-search hydration lease.
This is a correction to existing search behavior, without new product intent.
Renderer-specific math, diagram, image-state and other widget representations
remain approximate; this change does not claim universal DOM/index equivalence.

## Verification and acceptance

The existing search suite now asserts user/assistant occurrence order and counts,
plain identifiers, inline/backtick/tilde/unclosed code, emphasis, deletion,
escapes/entities, actual DOM marks (including a match split across emphasis),
active-result switching, query changes, clear/close, streamed replacements and
handoff. The outline and conversation-view suites check refreshed summaries,
bounded previews, retained settled-block identity and search close/reopen.
Existing tool-exclusion and file-link arming coverage remains in those runs.

The browser tests use the real search bar and message rows in three synthetic
Storybook stories. Fresh Chromium contexts block non-loopback requests and assert
counts, marks, navigation, clearing, closing, reload and absence of page errors.
The [Markdown/code capture](2026-10-07-session-search-evidence/after-markdown-cases.png) shows all eight matches.
No real user conversations were read or saved. Native Electron, production,
mobile and the full unrelated browser suite were not run.

| Query | Before | After | Screenshots |
| --- | --- | --- | --- |
| `QA_RESUMED_OK` | 1 / 1, user only | 1 / 2; next selects assistant 2 / 2 | [Before](2026-10-07-session-search-evidence/before-literal.png), [after](2026-10-07-session-search-evidence/after-literal.png), [assistant active](2026-10-07-session-search-evidence/after-assistant-active.png) |
| `QA_RESUMED_OK —` | 0 / 0 | 1 / 1, assistant highlighted | [Before](2026-10-07-session-search-evidence/before-assistant-only.png), [after](2026-10-07-session-search-evidence/after-assistant-only.png) |
| `QARESUMEDOK` | 1 / 1, no mark | 0 / 0, no mark | [Before](2026-10-07-session-search-evidence/before-phantom.png), [after](2026-10-07-session-search-evidence/after-phantom.png) |
| Empty query | — | 0 / 0, no marks, original text preserved | [Cleared](2026-10-07-session-search-evidence/after-clear.png) |

Reproduce locally with:

```sh
NODE_ENV=development pnpm --filter @lody/components exec storybook dev -p 6107 --no-open --ci
LODY_STORYBOOK_URL=http://127.0.0.1:6107 pnpm --filter @lody/components exec playwright test tests/e2e/session-chat-search.spec.ts
NODE_ENV=test pnpm --filter @lody/components test tests/session-chat-search.test.ts tests/conversation-outline.test.ts tests/conversation-view-hooks.test.tsx tests/markdown-agent-file-link-menu.test.tsx tests/markdown-streaming-reparse.test.ts
```

Open `/iframe.html?id=sessions-sessionchatsearch--literal-underscores&viewMode=story`.
The screenshots were captured with `agent-browser --session lody-search-ca
screenshot <path>` at 1280 × 633, before changing the extraction implementation
and after applying the fix; no image content was edited.

Checks ran with Node `26.10.0` and pnpm `10.20.0` in the isolated worktree. All
pinned submodules were initialized without changing gitlinks; Kimi/Pi remained
outside the root workspace and were only read to resolve documentation links.
No protected document topics are registered, and no SHA approvals were changed.

| Command / scope | Actual result |
| --- | --- |
| Final search test file copied into a detached `72b118b58` source worktree; `NODE_ENV=test pnpm --dir /tmp/lody-search-baseline-caad69d5 --filter @lody/components test tests/session-chat-search.test.ts` | 20 failed, 6 passed; reused the same locked dependency install |
| Targeted five-file command above | 119 passed |
| Browser command above | 3 passed; no page errors |
| `pnpm check` on final implementation | Exit 1: typechecks, lint and script checks passed; components 4833 passed, 1 failed (`boot-shell` storage-unavailable case). Remaining chained guards and Electron tests did not run in this command |
| `NODE_ENV=test pnpm --filter @lody/components test tests/boot-shell.test.tsx` and the same command with `--dir /tmp/lody-search-baseline-caad69d5` | Both 18 passed, 1 failed with identical light-theme/280px versus null expectation |
| `pnpm --filter @lody/components typecheck`, `pnpm lint` | Passed; lint reported 0 errors and existing warnings |
| `pnpm --filter @lody/electron test` | 199 passed |
| `pnpm lint:i18n`, `pnpm check:code-collab-imports`, `pnpm check:platform-boundaries`, `pnpm check:public-boundary` (run separately after aggregate failure) | All passed |
| `pnpm format`, explicit `pnpm exec oxfmt` on changed tests/manifests | Passed; no unrelated changes retained |
| `pnpm run docs status` at start | 64 broken links from uninitialized submodules |
| `pnpm run docs check --base 72b118b584133edb66d2b4bbec1173c1a7d4a2a0` after initialization | Passed: 0 errors, 64 existing warnings |

Root build/package commands were not run. The aggregate is not fully green;
the independently reproduced baseline failure is outside this fix.
