# Drop tool images from persisted history

Status: implemented
Translation: current

[中文](2026-10-11-drop-tool-images-from-history.zh.md)

## Abstract

Ordinary ACP tools could persist image data and embedded image blob resources in
session history, although conversation attachments already use references. The
shared history projection now drops these tool image blocks instead of uploading
them. Root tools, imported histories and normalized child tools use the same image
filter while preserving their existing non-image content policies. Existing stored
history and provider execution output remain unchanged.

## Decision and boundaries

```text
Root tool / replay → root content projection ─┐
                                            ├→ drop tool images → HistoryWriter
Normalized child tool → child projection ────┘
```

`packages/shared/src/acp/tool-call-history.ts` owns image removal. Drop every ACP
image block, plus blob resources identified by an image MIME type or image data
URI. Keep resource links, textual resources and other media. Child projection
uses only this filter, preserving its read results and diffs rather than adopting
root terminal compaction. Omitted content retains the previous list; an image-only
replacement becomes an empty list.

Uploading every tool image was rejected because these execution artifacts need no
durable conversation copy. Filtering only root notifications was insufficient:
external imports share the root reducer, but normalized child tools have a separate
projection. This does not inspect arbitrary raw fields or rewrite legacy records;
unchanged opaque data still follows the [single writer decision](../architecture/2026-09-07-single-history-writer.md).
Existing R2-backed image and image-group attachments remain distinct from tool content.

## Verification

Behavioral coverage crosses a real Loro HistoryWriter for root and child output,
checks sparse updates and image-only replacements, and copies filtered history to
a fork. Import coverage exercises the shared replay boundary. Fixtures are
synthetic; this change does not migrate existing history or alter provider schemas.
