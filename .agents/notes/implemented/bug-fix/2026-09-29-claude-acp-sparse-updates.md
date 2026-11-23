# Consume the Claude ACP upstream 0.84.0 synchronization

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1103

[中文](2026-09-29-claude-acp-sparse-updates.zh.md)

## Abstract

Claude's upstream synchronization makes tool updates sparse and moves presentation metadata behind AIR negotiation. Lody's history filter discarded some field-only updates, its root reducer appended content lists, and its permission suggestion ignored decline-first standard options. This change advances the bundled adapter and fixes those consumers while retaining standard ACP negotiation, compact terminal storage, and Core ownership. Runtime delivery also needs SDK 0.3.284 and the matching verified Claude Code 2.1.284 artifacts; the fork package version remains 0.79.0. No authenticated provider session was used for validation.

## Delivery and dependencies

Lody bundles `apps/cli/src/claude-acp-entry.ts` from the workspace submodule after
`prepare:acp-adapters`; it does not download this adapter from npm at launch.
Pin `packages/acp-extension-claude` to merged commit
`5e7805800d792b8b036728d13948b7be352d8c69` from
[adapter PR #37](https://github.com/LodyAI/acp-extension-claude/pull/37).
Upstream 0.84.0 is a source baseline, not the fork's release number. At audit time,
npm reported 0.54.3 and GitHub's latest-release endpoint returned 404; neither
blocks this source-bundled path, and no release PR or publication was performed.

The old Lody gitlink still required SDK 0.3.280. Align the CLI's direct SDK
with the new adapter's 0.3.284 and its native manifest, preserving startup's
version and integrity checks. Reuse immutable production artifacts only after
all eight public downloads match their SHA-256 and byte size. Keep the mirror's
existing provenance and runtime-manifest tests. Regenerate the workspace lockfile;
exact release-age exceptions follow the
[submodule lockfile decision](../process/2026-09-21-submodule-pointer-lockfile-regeneration.md).
Core remains the workspace-owned 0.1.9 contract.

## Consumer audit and changes

| Contract | Actual Lody path and result |
| --- | --- |
| Mode kind | `classifyPermissionModeFace` uses stable IDs, including `auto` and `bypassPermissions`; no AIR metadata needed. |
| Permissions | Standard tool title/kind/locations and all offered options remain available. Keep generic heading and absent reason when AIR-only presentation is absent. Suggest single-use refusal for decline-first requests; retain legacy `defaultToNo`. No approval is sent merely by suggesting it. |
| Sparse tool updates | Preserve field-only updates after terminal compaction. Merge by toolCallId using the previous kind/Core tool name for projections. Replace content and locations, including empty lists; reuse omitted fields. Locally derived command blocks remain independent rawInput projections on output replacements. Edit-evidence lists replace too, so stale paths are not resurrected. |
| Diffs | No AIR diffPatch negotiation; standard old/new text remains the source for CLI evidence. All Changes counts come from local git/PR comparison, not removed adapter diffStats. Root edit bodies are intentionally omitted from durable history; existing approval previews remain path-only, as documented in the permission Spec. |
| Authentication | `isAuthenticationRequiredACPError` recognizes JSON-RPC -32000 and wrapped causes; execution routes it to `acp_auth_required` and terminates the old runtime so login/retry can recreate it. No access-failure notification dependency. |
| Terminal / notices | Initialize advertises neither terminal_output_delta nor session.notices. The adapter therefore uses standard content/text fallback supported by Lody's current SDK/schema. Do not claim an unimplemented feature or identify as AIR. Completed terminal tails remain bounded and single-rendered. |
| Steering | `_lody/session/steer` still requires inject-or-refuse evidence and correlated applied events. Host prompt completion, transport ambiguity and retry classification retain their existing owners. |
| Subagents / plans | Core event run IDs are scoped by root session; ancestry, terminal fencing and permission attribution remain negotiated. Child tool arrays already replace correctly. Plan options are rendered by kind/ID, with no fixed count; accepted mode/config updates remain authoritative. |
| Other Core fields | Usage normalization and cancellation accounting, assistant UUID forkAtTurn metadata, goal, answer notes, tool names and compression activity retain the existing Core consumers. |

This partially supersedes the Claude metadata observation in the
[permission prompt decision](../feature/2026-09-24-permission-prompt.md).
The [permission Spec](../../../../specs/permission-requests.md) remains draft and
now includes standard decline-first suggestions. The existing
[subagent contract](../../../../specs/subagent-events.md) is unchanged.

## Verification

Synthetic regressions cover separate flushes and batched sparse updates, replacement
and empty lists, omitted read-kind filtering, scheduling raw-field retention, edit
evidence replacement, and keyboard selection of a metadata-free decline-first request.
`pnpm check` passed with Git configuration isolated for local fixture tests
(`GIT_CONFIG_COUNT=0 GIT_CONFIG_GLOBAL=/dev/null`); the session's GitHub App
URL rewrite otherwise changes the fixture remote's identity. CLI: 3227 passed,
4 skipped; shared: 1255 passed; components: 4555 passed. Adapter full suite:
2084 passed, 29 skipped. Formatting, docs, frozen install, public-boundary checks,
and the CLI production build with a 2048 MiB heap passed. The built
`claude-acp.js` completed a standard initialize handshake using the SDK's matching
native executable and advertised the retained Core capabilities. All eight
production artifact downloads matched the manifest. Live credentials, billing and provider
resume execution are not exercised; preserved contracts are checked through their
existing synthetic suites and adapter source, not claimed as live end-to-end proof.
