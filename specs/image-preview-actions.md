# Full-screen image actions

Status: draft
Translation: current

[中文](image-preview-actions.zh.md)

A person viewing a conversation image, queued attachment or file preview should be
able to take that same image out of the shared viewer without a screenshot.

- A stationary single-finger hold opens Copy Image, Save Image and Share actions.
  Movement, a second touch, cancellation and changing images cancel the hold.
  PhotoSlider continues to own panning, pinch zoom and gallery swipes.
- The menu belongs to the displayed image. Dismissing it or cancelling an OS action
  leaves the viewer open. Closing or changing the image invalidates the menu.
- Copy writes image pixels where bitmap clipboard access is available. Unsupported
  copy is visibly unavailable; copying a URL or text does not satisfy this action.
- Save retains original bytes and encoding. Native Save and Share use the existing
  file share sheet, where the user chooses the destination; handoff is not proof of
  a Photos save. Browsers may download and may share files when supported.
- Desktop right-click Copy/Save and its browser-menu fallback remain unchanged.

## Evidence and limits

Request: [#1284](https://github.com/LodyAI/Lody/issues/1284).
Implementation: `ZoomableImageViewer` and `lib/image-preview-export.ts` in
`packages/components/src`. Native bitmap clipboard support is not supplied by the
public repository; browser capability checks cannot prove iOS/Android permission
behavior. Physical-device gesture and system-sheet acceptance remains required.
