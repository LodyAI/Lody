# Native memory of rendered code tokens

Status: rejected
Type: architecture
Translation: current

[中文](2026-10-30-renderer-code-memory.zh.md)

## Abstract

The shared-style optimization candidate is withdrawn: its measured 20–28M
benefit is small relative to the application-wide memory symptom, and the current
investigation targets the dominant owner. The earlier roughly 180M diagnostic
removed visible syntax coloring and establishes no compatible optimization saving.
Measurements below are retained only as attribution evidence and to prevent
reintroducing feature removal as a memory fix. No production code was changed;
the temporary shared-style implementation and build have been removed.

## Conditions and evidence

Source: main `dc44d50a05f8c22842dd5e8ec65703036498b4da`. The earlier memory
PRs [#2099](https://github.com/LodyAI/Lody/pull/2099),
[#2100](https://github.com/LodyAI/Lody/pull/2100) and
[#2104](https://github.com/LodyAI/Lody/pull/2104) are not included; combined savings
are unmeasured. [Numeric evidence](assets/2026-10-30-renderer-code-memory.json)
contains no transcript, trace, profile or user data.

The OSS build runs real Electron 44.9.3 (Node 24.22.0), preload, renderer, IPC and
bundled CLI on macOS 27.2 arm64. Each run owns a disposable profile and endpoint;
only the external ACP provider is synthetic. The hidden viewport is 1280×1409 at
DPR 2 with background throttling disabled. After a 4 KiB warmup, a new Session
receives a 512 KiB code reply in 8 KiB chunks: 178 fenced TypeScript blocks.
Checkpoints await response/text/frame signals and explicitly collect main/renderer
GC before `vmmap`; no Playwright tracing or allocation sampling is active in the
paired runs. `M` below preserves the native footprint label, distinct from RSS.

| Completed reply reopened after leaving for Home | Original highlighting | Syntax coloring removed (diagnostic only) |
| ----------------------------------------------- | --------------------- | ----------------------------------------- |
| Renderer footprint, pair A                      | 541.3M                | 361.9M                                    |
| Renderer footprint, pair B                      | 538.5M                | 358.9M                                    |
| Renderer live JS heap                           | 117.6–118.7 MiB       | 101.9 MiB                                 |
| DOM nodes                                       | 156,380–156,423       | 5,403                                     |
| Elements in the document                        | 80,661–80,662         | 3,765                                     |

The completed-turn remount excludes the streaming-to-static handoff as the sole
cause. A preceding independent pair captured just after the reply: footprint
543.5/541.0M versus 401.8/401.6M, about 139–142M lower. These phase-specific
measurements must not be collapsed into one universal saving. RSS is noisy:
one active pair reports only about 13 MiB difference despite a 142M footprint
difference. Native DOM/layout storage and React's representation both matter;
live JS heap alone substantially understates this candidate.

`MarkdownCodeBody` in `markdown-code-block.tsx` maps every highlighted line and
every token to spans. Turn-level windowing does not bound the markup inside a
mounted turn. The control changes only that body to joined token text, retaining
the highlighting hook, token cache, block wrappers and source content. It removes
visible syntax coloring. It is a feature-removal counterfactual, not a compatible
optimization. Calling this "simplified highlighting" or presenting its 180M delta
as an available behavior-preserving saving is incorrect.

A six-turn 512 KiB scout plateaus near 121–122 MiB of renderer heap while active;
leaving for Home returns to about 100 MiB and 2,588 DOM nodes. The highlight cache
already caps entries, total characters and per-input admission. Evidence supports
large active representation cost and some high-water retention, not unbounded
cache growth. An initial allocation profile includes Playwright's injected text
queries and is excluded from product allocation estimates; later paired probes
use native selectors/explicit response signals instead of global text queries.

## Other candidates and boundaries

- The withdrawn shared-style diagnostic retains all 72,624 token spans and content,
  replacing independent inline declarations with shared CSS rules. Completed
  reply footprint is 540.4M → 512.3M and 545.1M → 525.3M: 20–28M lower.
  Computed color, font-style, font-weight and text-decoration distributions match
  across every token in both rounds (six style groups in the tested theme).
  It does not eliminate the large node count. The render-time CSS injection and
  unbounded map were diagnostic implementation details; that prototype and its
  build have been removed, and no shared-style product change is proposed.
- Removing Monaco and its model-registry bridge in a temporary build lowers
  empty-page live heap from 80.2–80.3 to 70.6 MiB in two runs. Native footprint
  does not show a stable large reduction (291.8/308.2M versus 295.7/287.5M).
  A compatible lazy-load must defer the editor and its URI/LSP bridge together;
  deleting them is only a diagnostic. Rank it below code-token representation.
- Consecutive tokens with identical serialized styles could reduce one sample's
  72,624 spans to 59,808 runs (17.6%). This is a narrower alternative whose memory
  saving is unmeasured; do not equate the count reduction with byte savings.
- A separate control creates 20 small Sessions and returns Home after each.
  It retains 20 synthetic Agent processes. Current `SessionGCManager` defaults to
  20 minutes idle and a one-minute sweep; turn completion intentionally retains
  the Agent for reuse. The synthetic processes total about 1,949 MiB RSS, which
  is not a measurement of real-provider cost or recoverable Lody cache. Their
  processes are excluded from product-only totals and all exit on test shutdown.
  Changing retention is a separate lifecycle/policy decision: protect active
  turns, goals, pending work and native background work, and verify restoration.
  The withdrawn Session-residency proposal is not current authority.

## Disposition

The shared-style candidate and its production follow-up are withdrawn. Per-token
markup merging and visible-region rendering have no behavior-preserving memory
result here and are not the next task. Keep the existing highlighting, selection,
copy and scrolling experience. The next investigation measures application-wide
process ownership, actual provider runtimes and scaling with idle Sessions before
selecting a fix. This note supersedes no active decision; the
[headless Markdown decision](../../implemented/feature/2026-09-26-lobehub-streamdown.md)
remains unchanged.
