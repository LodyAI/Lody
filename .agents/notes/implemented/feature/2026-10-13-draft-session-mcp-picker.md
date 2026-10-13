# MCP selection before a child Session's first message

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1541

[中文](2026-10-13-draft-session-mcp-picker.zh.md)

## Abstract

Blank child-tab drafts previously used workspace-default MCP selection for the
first message without offering a picker. This was an explicitly documented
limitation in PR #141, rather than an established behavior accidentally broken.
Passing the existing hook's menu adds first-turn selection without adding storage
or changing dispatch.
Development verification covered selection, deselection and an empty catalog;
the draft-owner test is not retained, and the patched desktop has not been launched.

## Previous behavior and decision

`DraftSessionChatInterface` called `useSessionMcpSelection`, while its
`SessionChatInputArea` received no `mcp` prop. After promotion, the persisted
session surface passed that prop, explaining why selection appeared after a
message. Chat Landing already passed it before sending. The shared composer
[contract](../../../../packages/components/src/components/chat/AGENTS.md)
places per-turn selection in the "+" menu and hides it for an empty catalog.
It does not establish that the previous draft behavior violated reviewed intent.

[PR #141](https://github.com/LodyAI/Lody/pull/141) introduced the hook while fixing
draft promotion and first-message acceptance. Its comment explicitly said the
draft had no picker "yet", so the first turn used workspace defaults, matching
what the promoted composer resolved from an empty session document. Defaults are
only servers with `enabledByDefault: true`, not every catalog entry or the parent's
selection. This change extends that known limitation; it does not restore a lost
picker. The original bug classification is corrected here.

Reuse `mcpSelection.menu` and the existing first-turn builder. Waiting for a
message prevents selection for that first turn. Adding draft/session storage
would expand the change without fixing the missing connection. Selection keeps
the hook's existing component-local lifetime. Preserve explicit empty selections
under the [shared contract](../../../../packages/shared/AGENTS.md#workspace-mcp--roles).

## Verification and limits

- A temporary draft-owner test verified first-turn selection, deselection and
  an empty catalog through a substituted input surface. It failed on the previous
  default-only behavior and passed with the menu prop, verifying the added
  capability rather than prior product intent. That test is not retained in this PR;
  no automated draft-owner test remains for the new menu connection.
- Retained draft-tab, input-submission, attachment-menu and session-action suites
  passed after deletion: four files, 150 tests. They exercise adjacent behavior;
  full desktop end-to-end verification remains outstanding.
- `pnpm check` stops in shared-package type checking because the existing local
  DSH submodule does not export the required symbols:
  `DEEPSEEK_HARNESS_OFFICIAL_BASE_URL` and `isDeepSeekOfficialBaseUrl` are missing
  from its exports. Existing submodule changes were preserved.
- `pnpm format`, scoped code/note Oxfmt, Oxlint and diff whitespace checks passed.
  Root commands used the installed Homebrew Node 24/Corepack on `PATH`. Existing
  README table-format drift was left outside the patch. `docs check` reports
  two existing links to the absent DSH `src/session-history.ts`, in the English
  and Chinese 2026-10-10 tool-result note; the new documentation has no errors.

Current behavior is documented in the
[session README](../../../../packages/components/src/components/sessions/README.md#conversation-surface-and-composer).
