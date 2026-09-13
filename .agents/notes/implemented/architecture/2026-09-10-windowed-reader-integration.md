# Windowed conversation reads

Status: implemented
Translation: current

## Abstract

Opening a session uses a control-plane Mirror and one reader-backed
ConversationView. Directory rows are shallow; only leased or retained tail
bodies are materialized. Snapshot decoding and the initial directory still
scale with the whole conversation.

The existing HistoryWriter remains the single writer. Shared planners retain
permission, agent-output, import and editable-tail rules. Stored-copy handles
reuse the writer's provenance; they survive source disposal during a fork.

View events are structure changes or explicit changed turn ids. Derivations
invalidate evicted facts too. Async cache reads retain identity/epoch fences.
Storage and view events share structure/changed-id semantics. Goal, permission,
scheduling and file-diff consumers share one reference-counted fact table.
CLI reads are synchronous over the same storage reader; auto-seen reads only
shallow fields and permission decisions are checked before auto-approval.
Ordinary commands throw writer errors; only import and editable-tail replacement
retain phased outcomes. The array adapter serves static sharing pages. There is
no alternate session view, feature switch or complete memory command backend.

## Evidence boundary

Reader, writer and CLI regressions use synthetic Loro fixtures. The component
benchmark measures the shipped reader. Device-scale cold-open, streaming frame
time and long-session JS/WASM memory remain separate acceptance work.
