# Composer paste precedence

Status: draft
Translation: pending

## Scenario

A user copies a paragraph in Word, a shape in PowerPoint, or a range in Excel and
pastes it into a Lody composer. Those applications put several representations of
one selection on the clipboard at once: the text, an HTML version, and a picture
of the same selection. A user who copies a screenshot, an image file, or a
document puts only that one thing on the clipboard.

The composer has to decide which representation the user meant, because the two
cases are indistinguishable from the presence of a clipboard file alone.

## Precedence

Clipboard text wins over an image the source application rendered beside it. A
paste that carries text is a text paste: the text reaches the composer, and the
rendered picture is not attached.

An image counts as rendered-beside-the-text only when it arrives without a
filename of its own — unnamed, or a bare `image.<extension>` the engine
substituted. An image the user copied in a file manager keeps its own name and
stays an attachment, as does every non-image file, whatever text accompanies it.

A clipboard with no text is unambiguous: a screenshot, a copied image, and a
copied file all attach exactly as before. Whitespace-only clipboard text is no
text.

Both the session composer and the new-chat composer surface an escape hatch when
they drop a rendered image: a transient hint whose action attaches the image the
paste ignored, so nothing the clipboard carried is unreachable. Repeated pastes
replace the hint rather than stack it. The task comment box and the task body
editor follow the same precedence without the hint.

Collapsing a large paste into a pasted-text chip and attaching clipboard files
are independent: a clipboard carrying both produces both.

## Acceptance

- A clipboard carrying text and an unnamed or `image.<extension>` picture pastes
  as text, and the composer does not consume the paste event.
- The same paste offers an action that attaches the picture instead.
- A clipboard carrying no text attaches its image or file unchanged.
- A named image file attaches even when the clipboard also carries text.
- A non-image file attaches even when the clipboard also carries text.

## Evidence

- Decision: `packages/components/src/lib/file-drop.ts` (`selectPastedClipboardFiles`).
- Callers: `session-chat-input-area.tsx`, `chat-landing.tsx`,
  `use-chat-landing-image-draft.ts`.
- Executed: `packages/components/tests/file-drop.test.ts` covers the precedence
  table; `packages/components/tests/session-chat-input-submission.test.tsx`
  asserts the session composer leaves a rich-text paste to the browser.
- Not executed in this repository: the clipboard payloads real Office builds
  produce. The rule was derived from the reported symptom and from Chromium's
  documented behavior of exposing a clipboard bitmap as a file; no automated test
  can produce a genuine Office clipboard.
