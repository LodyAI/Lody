# Markdown code highlighting in a worker

Status: implemented
Translation: current

[中文](2026-09-23-markdown-highlight-worker.zh.md)

## Abstract

Opening a session whose code blocks had not been highlighted since page load ran Shiki
tokenization synchronously on the main thread: a Chrome trace of a tab switch showed one
141ms task, 83ms of it `codeToTokens`, right after the switch commit. The markdown code
plugin now sends uncached blocks to a module worker and delivers tokens through
Streamdown's existing asynchronous callback, while cache hits stay synchronous. Builds
without workers fall back to the same highlighter on the main thread. The effect on a
real switch has not been re-measured yet.

## Decision

- `lib/markdown-highlighter.ts` owns the highlighter configuration (languages, CSS-variables
  theme, JavaScript regex engine) for both the worker and the fallback, so they tokenize
  identically.
- `lib/markdown-highlight-client.ts` shares one round trip between identical in-flight
  requests, rejects a single failed tokenization without disabling the worker, and after a
  worker crash rejects everything pending and reports itself unusable. The plugin then
  highlights on the main thread instead of retrying the worker.
- `lib/markdown-highlight-worker.ts` creates the worker lazily with
  `new Worker(new URL(…), { type: 'module' })`; without `Worker` (unit tests, server
  rendering) it returns null. The site-docs marketing build keeps Vite's default `iife`
  worker format, which cannot code-split Shiki, so it aliases this module to a null shim,
  as it already does for the diff render worker.
- Streamdown renders the raw code until the callback arrives and has no request
  cancellation; the worker processes requests in arrival order, so a block's versions
  resolve in the order they were requested.

Deferring main-thread highlighting to idle tasks was the smaller alternative. It still
spends the time on the main thread and a long block remains one long task.

## Limits

A cache hit that follows a still-pending request for an older version of the same block
can be overwritten by the late result; the pre-existing lazy-loading path had the same
race. The worker loads its own copy of the Shiki grammars. Verification: client unit
tests, the component suite, production web and site-docs builds; not yet a new trace.
Related: [portal restyle](../bug-fix/2026-09-23-portal-full-restyle.md).
