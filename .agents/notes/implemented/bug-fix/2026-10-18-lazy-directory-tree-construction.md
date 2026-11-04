# Batch lazy-directory tree construction

Status: implemented
Translation: current

[中文版](2026-10-18-lazy-directory-tree-construction.zh.md)

## Abstract

The Files panel's provider-tree builder repeatedly searched and sorted sibling arrays while attaching lazy directories. A synthetic directory-only snapshot with 10,000 siblings took approximately three seconds on the main thread, although ordinary file paths were cheap. Construction now indexes directories within each sibling array and sorts each changed array once after insertion. The output contract remains unchanged, including lazy identities, loaded children, modified flags, file/directory collisions and final ordering. Performance depends on input shape; a mixed 5,000-file/5,000-directory snapshot was much cheaper than the directory-only case, and no production latency distribution is claimed.

## Decision and responsibilities

`hooks/use-code-session.ts` remains the owner of the pure provider-entry conversion and the existing Hook. Ordinary files still go through `buildFileTreeFromPaths`; lazy directories still use the same slash-segment normalization and last-entry-wins directory id. A per-call WeakMap indexes only directory children by full path, so a file at the same path remains a separate node. Newly created directory nodes and their sibling arrays are recorded for one final sort using the existing comparator. No provider subscription, fetching, publication, visible-row virtualization, or message timing changes.

```text
provider snapshot
  → build ordinary file tree
  → index directory siblings on first visit
  → attach lazy nodes and identities
  → sort each changed sibling array once
  → publish the same tree shape
```

The previous implementation searched siblings on every path segment and sorted after each inserted node. Keeping that code or only virtualizing rows retains quadratic work before rendering. A shared long-lived index was rejected because each new snapshot must remove stale nodes, flags and ids; construction-local indexing needs no cache invalidation or new lifecycle. This is pure computation and introduces no Effect migration unit or new data authority.

## Correctness and evidence

The owning provider-tree suite exercises mixed loaded files and lazy ancestors, directory id replacement, repeated/empty path segments, empty or missing ids, directory/file collisions, broad reverse-ordered snapshots, and live provider snapshot replacement. The existing file-tree, virtual-row and view-state suites retain modified propagation and expansion/selection coverage. Tests assert resulting tree/state, never timing thresholds or sort-call counts.

The preceding isolated production-browser audit observed 31.4 ms for 1,000 reverse-ordered lazy siblings, 286.5 ms for 3,000 and 3,017 ms for 10,000. An indexed, batch-sorted prototype produced equivalent output in 1.0, 2.1 and 6.8 ms. Those figures identify the algorithmic problem; they are not packaged-Electron or user-project acceptance. The default Code Collab scan budget is 10,000 entries, while a local project directory listing requests at most 1,000 children per level. No claim is made that all large repositories have this shape.

A production browser build using the final PR implementation constructed the same synthetic 10,000-directory shape in 8.2 ms (one observation, not a latency distribution). The 24 targeted provider/tree/view-state tests and root `pnpm check` passed; root `pnpm format` completed. `pnpm run docs check` reported only six pre-existing links into the uninitialized Kimi/Pi submodules.

The [file-surface guide](../../../docs/sessions-file-surfaces.md) owns current implementation behavior. Product regression and root-check results are recorded with the PR; raw user traces are excluded from this change.
