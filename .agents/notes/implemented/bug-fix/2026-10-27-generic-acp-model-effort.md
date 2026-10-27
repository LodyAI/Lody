# Derive generic ACP effort from the selected model config option

Status: implemented
Translation: current
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

Only the Devin gitlink moves, from `d49d357` to `15c12e1`, the merge of
[adapter PR #6](https://github.com/LodyAI/acp-extension-devin/pull/6).
That adds capability declarations; it cannot repair the host selection path alone.
The official runtime remains `3000.11.3`, so its download artifact/checksum manifest
needs no update. The adapter's own updated protocol manifest travels with the gitlink.
The CLI bundler now inlines every manifest read, including the new protobuf-layout
reader, so the relocated adapter does not require a sibling manifest file.

## Verification and limits

Synthetic behavior tests exercise both derivation stages for custom and registry
agents, arbitrary config ids, empty effort, restoration, invalid model fallback,
full runtime snapshots, and dispatch filtering. Existing built-in selector coverage
remains in the same suites. A bundle-contract test imports the transformed real
adapter manifest module without a filesystem sibling. Real authenticated Devin
sessions and desktop interaction are not exercised by these tests; declaration
availability still depends on the adapter finding a compatible local model cache.
