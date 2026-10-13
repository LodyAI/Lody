# MCP selection before a child Session's first message

Status: implemented
Translation: current

[中文](2026-10-13-draft-session-mcp-picker.zh.md)

## Abstract

Blank child-tab drafts did not offer MCP selection before the first message,
even when the workspace catalog contained servers. The draft already computed
the selection and included it in the first-turn configuration, but omitted the
menu prop when rendering the input surface. Passing the existing hook's menu
restores the shared picker without adding storage or changing dispatch.
Behavioral tests cover selection, deselection and an empty catalog; the patched
desktop has not been launched.

## Cause and decision

`DraftSessionChatInterface` called `useSessionMcpSelection`, while its
`SessionChatInputArea` received no `mcp` prop. After promotion, the persisted
session surface passed that prop, explaining why selection appeared after a
message. Chat Landing already passed it before sending. The shared composer
[contract](../../../../packages/components/src/components/chat/AGENTS.md)
places per-turn selection in the "+" menu and hides it for an empty catalog;
the draft's omission was an implementation gap.

Reuse `mcpSelection.menu` and the existing first-turn builder. Waiting for a
message prevents selection for that first turn. Adding draft/session storage
would expand the change without fixing the missing connection. Selection keeps
the hook's existing component-local lifetime. Preserve explicit empty selections
under the [shared contract](../../../../packages/shared/AGENTS.md#workspace-mcp--roles).

## Verification and limits

- Before the fix, `draft-session-chat-interface.test.tsx` failed because the
  configured server had no selectable control. The same test passes after the fix
  and checks the actual first-turn payload after selection and deselection.
- The draft, draft-tab, input-submission and attachment-menu suites passed:
  four files, 75 tests. The draft test substitutes the large input surface with
  controls consuming its public contract; the draft owner, selection hook and
  input-config builder remain real. It is not desktop end-to-end verification.
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
