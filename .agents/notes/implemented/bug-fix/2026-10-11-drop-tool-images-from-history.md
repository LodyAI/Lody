# Drop tool images from persisted history

Status: implemented
Translation: current
PR: [LodyAI/Lody#1456](https://github.com/LodyAI/Lody/pull/1456)
Follow-up PR: [LodyAI/Lody#1473](https://github.com/LodyAI/Lody/pull/1473)

[中文](2026-10-11-drop-tool-images-from-history.zh.md)

## Abstract

Ordinary ACP tools could persist image data and embedded image blob resources in
session history, although conversation attachments already use references. The
first shared projection dropped tool images instead of uploading them. A follow-up
clears unused non-image resource blob bytes while preserving download references
and removes redundant child raw copies. Audio, readable output, complete diffs,
approval plans and permission/scheduling metadata remain available. Existing stored
content is preserved during permission enrichment; malformed new input still
reaches writer validation. This is a targeted cleanup, not a general binary-size cap.

## Initial image decision (#1456)

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

## Follow-up: binary and redundant payloads

The detail view reads non-image resources through their URI, never their blob
bytes. Clear the blob string while preserving the resource variant, MIME type,
annotations and URI. A data URI is already disallowed by the URL policy; clear
that unused URL and retain the link label or resource text. Audio has a real
player, raw output has a JSON/text view, and diffs render their full old/new text:
these are used data and stay intact.

Child raw input retains `plan`, consumed by plan approval; other newly supplied
input and the unconsumed scalar/array input copy are omitted. Scalar/array raw
output stays readable once, without `_meta.lody.subagentRaw`. Preserve ordinary
object raw output, metadata and root scheduling/permission fields. Omitted updates
retain prior stored fields. Existing histories are not bulk migrated.

General size budgets and base64 heuristics were rejected for this cleanup because
they also remove visible output and may corrupt permission metadata. The earlier
projection silently discarded malformed new locations and reparsed legacy content;
five CLI CI regressions exposed those validation/compatibility violations. The
filter now transforms only known unused resource fields, without schema reparsing.
Permission enrichment reuses the existing content list untouched. The writer
continues to reject invalid new fields atomically and accept a later valid request.

Real Loro/fork/replay tests assert blob removal with preserved resource references,
audio, long text, complete diffs and approval plans. CLI batching and permission
writer suites cover invalid-input isolation, atomic rejection and legacy container
identity. Ordinary conversation attachments and provider execution output remain
unchanged. Audio and visible/opaque output can still be large; storing those through
references requires a separate design that preserves their consumers.
