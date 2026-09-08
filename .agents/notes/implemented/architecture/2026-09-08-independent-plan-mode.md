# Independent Plan configuration across ACP providers

Status: implemented
Translation: pending

## Abstract

Kimi's ACP adapter combined planning and approval into a single selector even
though its TUI could enable both. The shared Core contract now defines a boolean
`plan_mode` option for Codex, Kimi, Grok, and supported DSH presets, with native
translation inside each wrapper. Claude remains permission-based. Source changes
require a coordinated Core package and Kimi runtime release before rollout;
local verification does not establish published artifact availability.

## Decision

The [Spec](../../../../specs/independent-plan-mode.md) describes intended behavior.
Use standard ACP configuration transport and a Core-owned field, rather than
exporting Codex's `collaboration_mode` vocabulary or introducing a custom RPC.
Planning is independent of approval but does not imply identical tool restrictions
across providers. DSH planning is guidance; its sandbox remains independent.

Codex converts boolean to native default/plan. Grok converts it to session mode
while retaining permission state. Kimi calls its independent Plan and permission
services and reads their native state on restore; Klient gains a typed permission
read over the existing service property. DSH resolves the service from the Agent's
current composition and reports pending selections until the native step commits.

Lody translates legacy Codex/Grok/Kimi selections at read/dispatch boundaries only
when the target offers the new option. Canonical boolean values win. Claude is
not migrated; its SDK still treats Plan as a permission mode.

## Verification and rollout

Focused tests cover strict boolean dispatch, independent permissions, legacy
selection reads, and Plan exit. Final check results and release artifact details
are recorded with the delivered change. Core must be released before wrappers
that import the new exports. Kimi remains an isolated workspace consumed as a
checksummed runtime artifact, never a root-workspace dependency.

Related issue: [Lody #133](https://github.com/LodyAI/Lody/issues/133).
No PR or package publication is implied by this note.

## Local check results

- Final pre-PR `pnpm check` passed in full: type checking, lint, workspace tests,
  Electron tests, i18n, import guards, platform boundaries, and public boundaries.
- Codex: 566 passed, 27 skipped; type checking passed. The config tests were
  rerun successfully after renaming the local alias to the Core constant.
- Grok: 41 passed. DSH: 11 passed, including pending state and capability removal
  when switching to the minimal preset.
- Kimi ACP: type checking and the 32 focused configuration/notification tests
  passed. Its full suite had 161 passes and one Bash local-output failure; the
  identical failure was reproduced against the unchanged submodule source.
  The CLI bundle built and a checksummed, non-publishable local preview was packed.
- `pnpm format` ran; unrelated formatting was removed. `pnpm run docs check`
  passed with existing AGENTS size warnings. These checks do not approve this Spec.

Core 0.1.1, Codex 1.10.1, Grok 0.1.1, and DSH 0.1.2 are prepared source versions,
not published versions. The production Kimi runtime manifest remains on its
published artifact until a coordinated release; the dirty preview is not a
production manifest replacement. The five submodule PRs are merged; the Lody integration remains in draft.
Package and runtime publication is separate from these source merges.

## Review dependencies

- [Core #5](https://github.com/LodyAI/acp-extension-core/pull/5)
- [Codex #34](https://github.com/LodyAI/acp-extension-codex/pull/34)
- [Grok #13](https://github.com/LodyAI/acp-extension-grok/pull/13)
- [DSH #12](https://github.com/LodyAI/acp-extension-dsh/pull/12)
- [Kimi #8](https://github.com/LodyAI/acp-extension-kimi/pull/8)

The submodule pointers now target their merged default-branch commits. All six
submodule source trees are identical to the previously verified versions; Claude
was already current. Release Core first, then release the wrappers. Keep the Lody change
in draft until the managed-runtime artifact is updated to the reviewed Kimi
implementation. The source pointer now includes the Kimi PR; its patch changeset
was confirmed before submission.
