# Consume acknowledged editor snapshots so remounts keep unsaved drafts

Status: implemented
Translation: current

[中文](./2026-09-11-file-preview-replays-stale-snapshot.zh.md)

## Abstract

After an explicit Refresh, Code Collab kept the applied `externalTextUpdate` in parent state. Switching preview or file tabs remounts the editor; the new instance replayed that snapshot, replacing the unsaved draft and clearing dirty. The acknowledgement handler now consumes the matching seq, while leaving a newer pending update in place.

## Decision

- Consume the snapshot on both `applied` and `no-op` acknowledgements. Same-text Refresh is a no-op and would otherwise replay after remount.
- Compare seq in a state updater so a newer update that arrived before the ack is not dropped.
- Keep the last acknowledged external text as the remount source for a clean editor. `subscribeText` does not advance `data.snapshot`; without that source, Preview then Hide preview rolls back to the open snapshot.
- Bind each ack to the snapshot text it was applied against. Remount uses the ack only while that snapshot is unchanged; a later openFile/Refresh that advances the snapshot drops the stale ack.
- Dirty remounts still use the local draft (`hasAcceptedLocalContentChange` / dirty), not the acked snapshot.
- Do not change save APIs, disk writes, or conflict `preservePending` handling. `load_with_conflicts` still keeps the pending buffer after apply.

## Evidence and limits

Native `SessionFileContentView` + `NativeMarkdownSource` regressions cover preview remount with and without Refresh, and a clean `provider.saveText` live subscription that must survive Preview then source. Isolated Chromium with the real Monaco viewer, controller, and `CodeCollabSessionFileProvider` (synthetic in-memory runtime, not packaged Electron) showed the same Refresh-then-switch loss before the change and retained the draft, explicit Save, and a later Refresh after it. A Windows 0.93.3 user report matched the Refresh-then-switch-file path; that binary was not mapped to this commit, and GitHub has no public `v0.93.3` release. Packaged Electron click-through was not run here.
