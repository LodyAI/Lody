# Avatar image editing

Status: draft
Translation: current

[中文](avatar-image-editing.zh.md)

## Scenario

When a user chooses a user or workspace avatar, the editor opens before any
network request. The user can drag the image and adjust its zoom inside a fixed
square selection, then either cancel or confirm the result. A confirmed edit is
uploaded through the existing avatar endpoint and becomes the new avatar only
after the upload and persistence callback succeeds.

## Responsibilities

- The browser validates the selected file using the existing avatar MIME,
  extension, and size rules before opening the editor.
- The editor keeps the selection square for both avatar kinds. User avatars may
  show a round selection mask, while workspace avatars show a square mask; both
  produce square image data.
- Confirming renders the selected source rectangle to a bounded canvas file
  before calling the existing upload callback. Cancelling, dismissing, or a
  failed export/upload leaves the current avatar unchanged.
- Avatar presentation preserves the source proportions with a cover fit, so
  avatars uploaded by older clients are not stretched while this editor is not
  open.

The crop is a client convenience. The server continues to authenticate and
validate the uploaded file, and clients that bypass this editor may still send a
non-square image. The display rule therefore remains necessary for historical
and externally uploaded avatars.

## Interactions

The editor is modal and owns a temporary object URL for the selected file. The
zoom slider and pointer/keyboard crop interactions update local state only. The
confirm action is disabled until the cropper reports a pixel area, and it stays
busy while the canvas export and upload are in progress. The same file can be
selected again after cancellation because the file input is cleared after every
change event.

## Evidence

The implementation lives in
[`avatar-editor.tsx`](../packages/components/src/components/settings/avatar-editor.tsx),
[`avatar-crop-dialog.tsx`](../packages/components/src/components/settings/avatar-crop-dialog.tsx),
and [`avatar-crop.ts`](../packages/components/src/lib/avatar-crop.ts). The
export path is covered by
[`avatar-crop.test.ts`](../packages/components/tests/avatar-crop.test.ts), and
the component has a Storybook state in
[`ProfileSettings.stories.tsx`](../packages/components/src/stories/ProfileSettings.stories.tsx).
