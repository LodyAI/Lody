# Derive generic ACP effort from the selected model config option

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1968
Language: [中文](2026-10-27-generic-acp-model-effort.zh.md)

## Abstract

Registry and custom agents select models through a category-bound config option,
but effort derivation used the dedicated model field or the probe-time default.
The composer therefore kept the wrong ladder even when the adapter declared each
model's capabilities. Both derivation stages now use the actual model config id,
and final resolution validates that value before deriving effort. The config-option
wire representation and full runtime snapshot semantics remain unchanged.

## Decision and evidence

This corrects the generic-agent UI path described in the
[per-model capability decision](../architecture/2026-09-29-per-model-acp-capability-row.md),
tracked by [#1957](https://github.com/LodyAI/Lody/issues/1957).

- Candidate selectors read `configOptionValues` through the option with category
  `model`, without assuming its id is `model`. Built-in model selection is unchanged.
- Final selection reuses the existing config-table resolver: valid user edits win;
  a present runtime table owns the non-user key set, including omitted keys; only
  the no-runtime path uses preferences and selector defaults. An omitted model key
  may use the probe default for display but is never inserted into the dispatch table.
- Generic agents retain unnormalized probed selectors. An unsupported candidate may
  hide effort, but authoritative validation can fall back to a supported model;
  reusing the already-filtered selectors would lose the control permanently.
  Empty effort declarations hide the control and remove it from authoritative dispatch.
- The alternative of populating dedicated model options would change the generic
  agent's dispatch representation. Keeping category-bound config values avoids that
  protocol change. No arbitrary effort id is synthesized when the probe had no control.

## Devin integration

The Devin gitlink moves from `d49d357` to `15c12e1`, the merge of
[adapter PR #6](https://github.com/LodyAI/acp-extension-devin/pull/6).
That adds capability declarations; it cannot repair the host selection path alone.
The official runtime remains `3000.11.3`, so its download artifact/checksum manifest
needs no update. The adapter's own updated protocol manifest travels with the gitlink.
The CLI bundler now inlines every manifest read, including the new protobuf-layout
reader, so the relocated adapter does not require a sibling manifest file.

## Pi follow-up: startup model ordering

[Pi adapter #24](https://github.com/LodyAI/acp-extension-pi/pull/24) supplies
per-model ladders, but its startup parser drops the dedicated `modelId` sent by
the host. Thinking can consequently be applied to the previous model and reject
an otherwise valid level. [Adapter #25](https://github.com/LodyAI/acp-extension-pi/pull/25),
commit `989532ea55ee27a6d7a8455ae736c54022cb0dea`, selects `modelId` first,
falls back to the string model config option, and only then applies thinking.
Malformed independent fields do not discard the remaining startup configuration.
Non-reasoning Pi models declare `["off"]`, not an empty ladder; Off remains visible.
No host-specific wire workaround or adapter source modification is needed.

Pi is an isolated downloaded runtime, unlike the bundled Devin adapter. Its
gitlink and `pi-runtime-manifest.json` must move together after artifact
publication and integrity readback, following the
[managed-runtime refresh decision](../process/2026-09-17-managed-runtime-refresh.md).
The production pins remain at `81c960da` until that distribution step is available.
The candidate uses both Windows binaries from successful exact-commit
[CI run 40500946908](https://github.com/LodyAI/acp-extension-pi/actions/runs/40500946908).
Local Pi checks pass (111 tests, one skip), as do build and the real CLI synthetic
smoke. These checks do not establish production artifact availability or an
authenticated provider session. The generated package passes the packaged-closure
smoke and two byte-identical archive builds. Host managed-runtime and startup
suites pass against the candidate manifest (57 tests). The canonical candidate
URL returns HTTP 404, so the integration is blocked on immutable publication.

Candidate version: `0.2.0-lody.989532ea55ee`; file:
`lody-pi-0.2.0-lody.989532ea55ee-88928a6b2a8c81a6.tar.zst` (16,188,064 bytes).
SHA-256: `88928a6b2a8c81a67d2902cce4c4695774cd351c74c707ec4481bbcf349b5956`.
Publication must be followed by full canonical-download hash/size verification;
then update the gitlink and manifest together. No release or upload was performed.

## Verification and limits

Synthetic behavior tests exercise both derivation stages for custom and registry
agents, arbitrary config ids, empty effort, restoration, invalid model fallback,
full runtime snapshots, and dispatch filtering. Existing built-in selector coverage
remains in the same suites. A bundle-contract test imports the transformed real
adapter manifest module without a filesystem sibling. Real authenticated Devin
sessions and desktop interaction are not exercised by these tests; declaration
availability still depends on the adapter finding a compatible local model cache.
