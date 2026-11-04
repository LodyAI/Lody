# Kimi media output in ACP history

Status: proposed
Translation: current

[中文](2026-11-04-kimi-media-output.zh.md)

## Abstract

Kimi can send a media tool result as one JSON text block containing a base64 image,
which Lody displays as a long string. The proposed adapter change sends recognized
image data as ACP image blocks, keeping accompanying text in order. Lody already
filters tool images from persisted history, so this removes the encoded text without
adding an image preview. A separately built, published, and verified managed runtime
is still needed before installed clients receive the fix.

## Boundary and trade-off

[Kimi PR #20](https://github.com/LodyAI/acp-extension-kimi/pull/20) fixes the source
conversion. It retains the existing output for non-media or unrecognized arrays and
continues to send `rawOutput`. Lody's existing [tool-image history policy](../../implemented/bug-fix/2026-10-11-drop-tool-images-from-history.md)
removes structured images rather than persisting or displaying them. Adding a generic
base64 heuristic in Lody could discard legitimate text and is not required for this
known provider format. Existing stored results are not rewritten.

## Delivery and evidence

The adapter tests exercise mixed text and image results, multiple images, errors,
and unchanged fallback results. A synthetic notification produced by the adapter
was applied to Lody history, preserving text and omitting image data. The Lody test
also checks the writer boundary with the adapter's content and raw output shape.
No authenticated Kimi request or installed runtime has been verified.

The source gitlink alone does not update the managed runtime. Build a clean Kimi
artifact, publish it to the runtime channel, and verify its checksum and availability
before changing the manifest. If the Kimi PR is squash-merged, update the gitlink
to the resulting commit before building. Until then this source integration does
not fix installed Lody clients and the issue should remain open.
