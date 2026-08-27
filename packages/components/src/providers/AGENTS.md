# Workspace provider guidelines

`CLAUDE.md` is a symlink to this file. Parent `AGENTS.md` files also apply.

## Streams connection cardinality

- Capability discovery and refresh must reuse the workspace runtime's existing Machine
  Flock and Machine RPC transports.
- Never create or retain a Streams/Flock subscription per agent config or refresh request.
  Live connection cardinality must stay bounded by workspace/machine topology and must not
  grow with the number of agent configs. More configs may add serialized RPC requests, not
  live Streams connections.
- Release any one-shot document handle or subscription that is not already owned by the
  workspace runtime.

## Workspace switching

- The `$workspaceName` route owns the render-time target slug. Workspace-scoped UI must
  require that target, the active runtime, and the runtime-owned doc-meta snapshot to agree
  before reading singleton caches. Visibility hooks must receive an explicit scoped workspace
  id and `enabled: false` during mismatch so previous-scope queries and Machine Flock work do
  not start behind a hidden loading state.
