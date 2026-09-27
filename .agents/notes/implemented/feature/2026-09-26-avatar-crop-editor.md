# Frontend avatar crop editor

Status: implemented
Translation: current

[中文](2026-09-26-avatar-crop-editor.zh.md)

## Abstract

Avatar uploads previously sent the selected source file directly to the
existing endpoint, leaving callers with no way to choose a square composition.
The settings editor now opens a square drag-and-zoom surface before upload and
exports a bounded canvas file, while avatar display keeps using cover fitting for
older non-square uploads. `react-easy-crop` was chosen after comparing the
available React crop libraries; the remaining limit is that client editing is a
convenience and is not a server-side square-image contract.

## Decision

Use `react-easy-crop` 6.2.3 for the interaction surface. It provides the needed
pointer, touch, keyboard, and zoom behavior with a small dependency footprint
and no imperative cropper instance. `react-image-crop` is lighter but leaves
zoom and media positioning to the caller; `react-cropper` is more featureful
but brings CropperJS and an imperative integration model that is unnecessary for
this avatar flow.

`AvatarEditor` validates the original file, opens `AvatarCropDialog`, and calls
the existing upload callback only after `cropAvatarFile` renders the selected
pixel rectangle. User and workspace previews share the square aspect; the user
preview uses a round mask. PNG and WebP retain their format when the browser
encoder produces a valid file within the one-megabyte avatar limit. Other images
use JPEG, and unsupported or oversized canvas output falls back to a bounded
JPEG attempt. The existing `@lody/ui` avatar primitive already uses
`object-fit: cover`, so no separate display workaround was added.

The behavior is recorded in the draft [avatar image editing Spec](../../../../specs/avatar-image-editing.md).

## Evidence and limits

The export tests cover square output dimensions, source-rectangle forwarding,
JPEG background handling, filename/type conversion, and object URL cleanup.
Storybook adds an open cropper state beside the existing avatar states. The
targeted export suite passed two tests, targeted type-aware Oxlint passed with
zero diagnostics, formatting passed, and the translation-key check passed.

The full workspace typecheck could not be completed in this checkout because
the ACP extension submodule directories have no package manifests; the isolated
install also had to use the available package metadata to inspect the new
dependency. Browser-level pointer behavior and native image decoder differences
remain outside this validation.
