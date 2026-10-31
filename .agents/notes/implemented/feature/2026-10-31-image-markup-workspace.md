# Image markup workspace

Status: implemented
Translation: current

[中文](2026-10-31-image-markup-workspace.zh.md)

## Abstract

The attachment markup lightbox centers the image over a darkened session and keeps drawing tools and colors in a floating toolbar. Rectangle and text marks can carry notes that are rendered into the accepted image and included in the chat context. The existing attachment replacement and cancellation boundary remains the owner of the result. Notes are flattened into the image, so they cannot be edited after acceptance.

## Decision and limits

The existing document-selection editor owns the canvas and its temporary marks; the session composer still validates and replaces the original draft only on acceptance. The session image viewer can also open the current image in the lightbox and stage the result as a new attachment and context; cancel returns to the same preview. The lightbox traps focus and restores it on exit. Undo removes the latest mark. The image remains bounded by the existing four-megapixel limit. This extends the [document-selection decision](2026-10-17-document-selection-and-image-markup.md) without introducing another attachment or persistence protocol.

Playwright exercises drawing, undo, a rectangle note and the accepted PNG, as well as the current-image action and viewer keyboard behavior. Storybook used the matching local ACP source because this checkout's submodule is absent. Live Electron and physical touch devices remain unverified.
