# Prompt Shortcut body prefetch

Status: draft
Translation: current

[中文](prompt-shortcut-body-prefetch.zh.md)

When a workspace exposes a Prompt Shortcut in its catalog, invoking that Shortcut should normally not wait for its Prompt body to download. After the workspace runtime and readable catalog are ready, the client schedules the current visible bodies for background loading during an idle window. Catalog discovery remains index-only and does not wait for body loading.

The runtime processes background body loads serially across catalog updates. A foreground invocation is never queued behind unrelated prefetch work; when it requests the same indexed body already in flight, it joins that request. Successful bodies use the existing account-and-workspace-local durable Shortcut store, so a later invocation can use the local copy.

Prefetch is best-effort. A failure does not hide the index entry or surface an invocation error, and a later catalog publication or online transition may retry it. Scope changes stop queued work. Every background read applies the same directory authorization and exact index/body revision checks as a foreground read, including checks after synchronization; prefetch never grants access or makes a stale entry invokable.

Body retention follows the existing Prompt Shortcut data-store lifecycle. This behavior introduces no second cache and no new deletion guarantee. Separating reclaimable remote replicas from offline authored data remains a possible storage improvement.

## Evidence

- Scheduling and workspace lifetime: `packages/components/src/providers/prompt-shortcut-provider.tsx`.
- Authorization, serialization and request coalescing: `packages/shared/src/prompt-shortcuts/runtime.ts`.
- Durable local storage: `packages/shared/src/prompt-shortcuts/local-store.ts` and `sync.ts`.
- Behavioral coverage: `packages/shared/tests/prompt-shortcut-runtime.test.ts` and `packages/components/tests/prompt-shortcut-provider.test.tsx`.
