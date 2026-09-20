# Clipboard text wins over the picture Office renders beside it

Status: implemented
Translation: current

[中文](2026-09-17-composer-paste-prefers-text.zh.md)

## Abstract

Pasting from Word or PowerPoint into a Lody composer produced an image attachment
and no text at all: those applications put a picture of the selection on the
clipboard beside the text, and every composer paste handler consumed the event
whenever the clipboard held any file. The handlers now route through one shared
decision, `selectPastedClipboardFiles`, which drops an image the source rendered
when the clipboard also carries text, while leaving screenshots, copied image
files, and non-image files attaching exactly as before. The discriminator for
"rendered beside the text" is the missing filename, not the MIME type, because a
clipboard file's name is the only signal that separates Chromium's synthesized
bitmap from a picture the user copied in a file manager — a heuristic, so the two
chat composers also offer an action that attaches the dropped image.

## The defect

`session-chat-input-area.tsx` and `chat-landing.tsx` read every `kind === 'file'`
clipboard item, and on finding one called `preventDefault()` and attached it. Word,
PowerPoint and Excel always ship a rendered bitmap beside their text, so that
branch fired on every Office paste and the text the user copied never reached the
textarea. `task-thread.tsx` and `task-body-editor-fallback.tsx` had the same shape.

Pastes over 1024 characters were unaffected, because `shouldCapturePastedTextDraft`
collapses them into a chip and returned before the file branch ran. That asymmetry
— short Office pastes become an image, long ones do not — is what identified the
branch.

## The decision

One pure function owns the choice, in `packages/components/src/lib/file-drop.ts`
beside the drop-time split it mirrors. Text wins when the clipboard has any, but
only against files that look like a rendering the source produced: image MIME plus
either no filename or a bare `image.<extension>`.

Both conditions are load-bearing in opposite directions. Text alone is not enough:
Finder and Explorer put a copied file's name on the clipboard as text, so "any
text wins" would turn a copied image file into a pasted filename. The filename
alone is not enough either: a screenshot is also an unnamed `image.png`, and it is
the absence of text that makes it unambiguous.

Two smaller behaviors came with it. Collapsing a large paste no longer returns
early, so a clipboard carrying both long text and a real file now produces both.
And the two chat composers show a transient hint with an "Attach image instead"
action, under a fixed toast id so repeated pastes replace it; the task editors
drop the rendered image silently, matching how other chat products behave.

## Alternatives

Reading `text/html` and deciding on Office-specific markers (`mso-`, conditional
comments) was rejected: Chromium's own "Copy image" also writes `text/html`
containing a bare `<img>`, so HTML presence does not separate the cases, and
marker lists go stale per Office version.

Treating any text as decisive, without the filename test, was rejected for the
file-manager regression above.

Attaching the image and inserting the text together was rejected: for the common
case the picture is a duplicate of the text that would be uploaded and sent to the
agent, and there is no cheap way to tell a duplicate from a wanted figure.

## Verification and limits

`packages/components/tests/file-drop.test.ts` covers the precedence table:
rendered bitmap, unnamed bitmap, screenshot, whitespace-only text, named image
file, non-image file, and a clipboard carrying both a real file and a bitmap.
`packages/components/tests/session-chat-input-submission.test.tsx` asserts at the
component boundary that a text-plus-bitmap paste is not consumed; that test was
confirmed to fail against the previous routing.

No test exercises a genuine Office clipboard — jsdom has no clipboard, and the
component tests cannot follow the attaching path because `URL.createObjectURL` and
the image upload are unavailable there. The attaching direction is therefore
covered at the helper, not at the composer. Whether Chromium names a rendered
bitmap `image.png` on every platform and Office version is unverified here; when
it names one something else, that paste falls back to the previous behavior and
the hint's action is not needed because the image is already attached.

Intent is recorded in [composer paste precedence](../../../../specs/composer-paste-precedence.md).
The other decision in this handler, the 500 KiB ceiling, stays where it was:
[composer paste size ceiling](../feature/2026-09-14-composer-paste-size-ceiling.md).
