# Session history streaming writes

The Loro backend keeps one `HistoryWriter` over the stored document. CLI agent
output goes through `createSessionAgentWrites`; `targetLocalHistoryTargets`
collects the batch's tool ids, legacy task ids, normalized `(sessionId, runId)`
identities and explicit parent dependencies. The shared notification reducer
still owns event order, ancestry validation, terminal-state rules and content
filtering. This storage optimization changes none of those protocol decisions.

```text
ACP notifications, in delivery order
  → targetLocalHistoryTargets: requested identities and ancestry
  → HistoryWriter.updateTail: owning turns and sparse item windows
    → root tools/tasks + active text/thought tail when needed
    → child tools/plan + output tail for text/thought appends
  → shared reducer → validate every changed window → commit
```

`history-agent-window.ts` is an internal part of that writer, not a second
writer. Its directory indexes scalar metadata without exporting item payloads.
Tool and legacy task lookup selects the newest owning row and its first matching
item. Normalized runs instead select the first exact root/run match. Only root
text/thought deltas read the active turn's tail; child text/thought deltas read
the child's last output item. Sparse rows retain stored order, so mixed batches
and new children of an older task/tool
append to the actual end of their owning turn. A reducer-local run index avoids
repeating linear searches for each event in the same batch.

The directory is complete only at its recorded document version. Its own window
writes update affected positions; writer field writes retain it because they
cannot change history/item identity. Other writes and remote imports invalidate
it. The next window rebuilds root metadata once; a child's tool/plan directory
is built only when its output is first needed. Neither scan converts historical
text/tool payloads. The first write and writes after imports therefore still
have a metadata-scan cost, rather than constant work in all circumstances.

Existing child lists are projected separately from task/snapshot/progress fields.
Unselected items are neither validated nor rewritten. Changed windows all pass
the shared history parsers before the first mutation; a rejected command commits
no valid prefix. Container layouts, streaming text fields and opaque stored
extensions are preserved. No transcript cap or storage migration is introduced.

Missing or duplicated target turns, inline turn/item-list storage, rich contents
and structural/singleton commands keep their existing fallback. Inline individual
items remain inline and may require reading/replacing that individual value.
This does not change snapshot exports, explicit full-history reads, sync deadlines
or lock policy. The independent Roost backend does not use this Loro writer.

Behavioral and read-boundary regressions live in
[`session-history-storage.test.ts`](../../apps/cli/tests/session-history-storage.test.ts)
and [`acp-history-apply.test.ts`](../../packages/shared/tests/acp-history-apply.test.ts).
The [decision and validation](../notes/implemented/bug-fix/2026-10-16-subagent-history-windows.md)
extend the earlier [tool streaming optimization](../notes/implemented/bug-fix/2026-10-14-daemon-history-writes-scale-with-turn-size.md).
