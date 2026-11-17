# Composer editor: one Lexical contenteditable instead of a textarea and mirror

Status: implemented
Translation: current

[中文](2026-11-10-composer-lexical-editor.zh.md)

## Abstract

The shared composer used to be a transparent `<textarea>` stacked over a mirror
`<div>`. The textarea owned editing and the caret; the mirror painted the text
and the mention chips. Whenever the two laid out differently, the caret sat on
another line than the glyphs being edited. In the 2026-11-10 report, the
textarea's classic scrollbar narrowed only the textarea, so the caret and the IME
window dropped a line below the text. Every mention-based composer now edits in
one Lexical contenteditable that paints its own text, caret, selection, IME
preedit and chips. Its external model is unchanged: a string plus UTF-16 ranges,
the same wire format, the same drafts. The owner's requirement was that users
notice nothing, so the editor reproduces the textarea's look and editing
semantics. Composers without mention sources keep a plain textarea. It is
verified in Chromium, WebKit, the Electron app, and with system Chinese IMEs in
iOS and Android simulators.

## Problem

The visible text and the caret belonged to two layout engines. Correctness
required them to agree on every wrap, and they cannot guarantee that:
scrollbars, fractional zoom, font fallback, chip widths and IME preedit all
moved them apart. The same class of bug had already shipped as #1128 and #1140
(menu not at the caret), #2366 (caret and colour at chip edges) and the IME
caret-snapping fix. Menu placement also needed a third, off-DOM clone just to
locate the caret.

Measured on the textarea build: a three-row composer holding long mixed-script
text, with scrollbars shown. Click on a visible glyph, then type. The character
lands 8–28 characters away at every frame width from 400 to 720px.
`tests/e2e/composer-editor.spec.ts` › "a click on a visible glyph puts the caret
there" pins this; it fails on the textarea and passes on the editor.

## Decision

- **Editor.** Lexical core, `@lexical/plain-text` and `@lexical/history`, exact
  pinned at 0.53.0, without `@lexical/react`. Chips render through portals into
  each decorator node's DOM.
- **Document.** One paragraph of text nodes, line breaks and `MentionDecoratorNode`s.
  A mention node's text content is exactly the text its range covered.
  `ui/mention/composer-document.ts` is the only place offsets are computed,
  between `{text, mentions}` and Lexical points, including live DOM points.
- **Owner model unchanged.** The owner still holds the string and ranges. An
  owner value that differs from the document rebuilds it. As when a textarea's
  value is assigned, the caret then goes to the end, unless the primitive asked
  for a specific caret, and the editor's own undo history is cleared, so undo
  cannot bring back a draft the owner cleared after sending. The written value
  becomes the base the next edit undoes to: Lexical's clear also forgets the
  current state, which left text typed after a committed chip impossible to undo.
  No owner write lands mid-composition, and the owner hears IME text only once
  committed.
- **Editing logic kept.** Arrows over chips, Backspace and Delete rules, menu
  keys, triggers, history snapshots and every insert route are today's string
  algebra, unchanged.
- **Handler order.** Caller `onKeyDown`, `onPaste`, `onCopy`, `onCut` and
  `onBeforeInput` run before Lexical, and Lexical's default is skipped when they
  call `preventDefault`. Script-dispatched input events edit nothing, as with a
  textarea.
- **Element and API.** The ref is still a DOM element, the editor `div`. Text,
  caret and geometry go through `ui/mention/composer-input.ts`, which serves both
  the editor and the plain textarea, so focus, `closest`, floating-ui anchoring
  and `activeElement` checks stay ordinary DOM.
- **Textarea parity.**
  - CSS gives it a textarea's UA box: inline-block, pre-wrap, `overflow: auto`.
  - It is `rows` lines high plus padding, and utilities can still size it.
  - A caller's `placeholder:` utilities style the editor's placeholder too, through
    a `placeholder` variant in `tailwind/index.css`. Without one, the UA placeholder
    colour is copied from a textarea styled like the editor. WebKit cannot report a
    `::placeholder` style, so there the copy is skipped and the CSS default applies.
  - Spellcheck is off and selection uses system colours wherever chips render,
    as under the mirror.
  - Programmatic and keyboard focus keep the caret, while a pointer places it.
  - The first content is written as the element attaches, so a parent's layout
    effect measures a filled editor, as it did a textarea.
  - Lexical's inline `word-break: break-word` is removed, keeping the textarea's
    wrapping.
- **Caret source.** The caret is Lexical's selection state. The live DOM
  selection is read only after a keydown that Lexical let through, until its next
  update. That keeps fast keys current without trusting engines that collapse the
  DOM caret on focus, as jsdom does. Composition follows the DOM composition
  events as well as Lexical's own flag.
- **Menu anchor.** The anchor is a DOM range on the editor, snapped to the
  element's line grid and scaled by transforms and zoom. Measuring inserts no DOM.

## Alternatives

- **Patch the mirror (scrollbar inset).** It fixed the reported case, but the
  owner rejected it: the class of bug remains.
- **ProseMirror or Tiptap.** ProseMirror is equally capable. Lexical was chosen
  because iOS already ships a Lexical model and the owner accepted it. Tiptap
  adds a rich-text layer this plain composer does not use.
- **A `textarea`-shaped ref facade.** Rejected as a hidden fallback; callers use
  the explicit element API.
- **Editor everywhere, including composers without mention sources.** Rejected:
  their plain textarea has no mirror and no bug, and keeping it is the only exact
  visual match.

## Consequences

- **Removed:** `mention-highlighter.tsx`, the caret clone, the issue-hover
  textarea geometry and the dead `FileAtMentionTextarea`. The textarea measurement
  remains only for the plain-textarea path.
- **Tests:**
  - jsdom tests drive the real editor through `tests/composer-test-utils.ts`.
  - Browser specs read text through `tests/e2e/composer-text.ts`.
  - `tests/setup.ts` supplies zero-size Range geometry, which jsdom lacks.
- **Chips:** they still keep their raw text's advance width (`mention-chips.tsx`),
  so a draft wraps and looks as before.
- **Rich text:** none on web yet; the editor makes it possible later without
  changing the owner model.

## Verification

- **Boundary:** `tests/composer-document.test.ts` covers round trips, sanitizing
  and offset/DOM mapping.
- **Behaviour:** `tests/e2e/composer-editor.spec.ts` covers typing, newlines,
  chips, arrows, Backspace/Delete, chip clicks, undo/redo (including after an
  owner clear, and after a committed chip in the editor's own history), paste, CDP IME
  (including next to a chip), accessibility, and caret on glyph under overflow.
  It passes on the textarea build except the caret-on-glyph case, and fully on
  the editor.
- **Existing suites:** the composer vitest suites, `composer-mention-placement`,
  `message-quotes`, `composer-submission-focus` and `interface-typography` show
  no failure beyond those that also fail on the textarea build in the same
  environment.
- **WebKit:** the same spec runs under Playwright WebKit (`LODY_E2E_BROWSER=webkit`)
  except its clipboard and CDP IME cases, which are Chromium-only. Its placeholder
  case failed there when the colour was copied from a `::placeholder` query.
- **Devices (2026-11-11):**
  - iOS Safari with the system pinyin keyboard passed mixed-script input, owner
    silence during composition, composition beside a chip, chip arrows and
    deletion, undo (including after a clear), paste, newline, the placeholder
    colour, click placement at two widths and a handle selection across a chip.
  - Android Chrome with Gboard passed pinyin input, click placement, the mention
    menu, chip deletion, newline, paste and long-press selection across a chip.
  - The Electron app's chat composer passed pinyin composition beside a chip,
    chip arrows and deletion, click placement under overflow, the mention menu,
    undo and redo of text typed or pasted after a chip, no undo after sending, and
    the sent message with its mention.
- **Not verified:** macOS's built-in pinyin in Electron (automation typed Latin
  letters; a third-party pinyin IME passed), a selection started by long-press
  alone on iOS, and iPhone landscape. The plain-text composers are unchanged.
