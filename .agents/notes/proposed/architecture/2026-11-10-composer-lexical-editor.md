# Composer editor: replace the textarea and mirror with Lexical (PRD)

Status: proposed
Translation: current

[中文](2026-11-10-composer-lexical-editor.zh.md)

## Abstract

The shared web composer (Electron desktop, browsers, the Capacitor mobile apps
and the responsive mobile web) is a transparent native `<textarea>` above a
mirror `<div>` that paints text and mention chips. The caret belongs to one layer
and the glyphs to the other, so any layout difference between them shows up as a
misplaced caret. The 2026-11-10 report is one such case: a textarea that overflows
gets a classic scrollbar, the mirror does not, lines wrap at different points,
and the caret sits lines below the text being typed. The owner decided to stop
patching and replace the textarea and mirror with one Lexical editor in every
mention-based composer, in one change, with interaction equal or better and
no visible change. The outgoing message format and local draft formats stay
byte-identical, so the native iOS and Android clients need no change. This is a
proposal for other agents to implement; nothing here is implemented or verified.

## 1. Background

### 1.1 Current architecture

- `packages/components/src/ui/mention/mention-input.tsx` renders a `<textarea>`
  with transparent glyphs (`-webkit-text-fill-color: transparent`) that owns
  editing, the caret and IME.
- `mention-highlighter.tsx` renders an absolutely positioned mirror below it that
  paints all prose, chips and selection. The mirror copies the textarea's computed
  font, padding and wrapping, and copies its scroll position and height.
- To place the `@` / `/` / `$` menu at the caret, `mention-input.tsx` builds a third
  off-DOM clone, inserted before `<body>`, on every measurement.
- Chips may not change advance width. Icons are painted over blank characters
  (figure spaces) already in the text (`components/mentions/mention-chips.tsx`).
- `combined-mention-textarea.tsx` (~1.2k lines) adds hydration, triggers, the chip
  resolver and imperative inserts. `ui/mention/` is ~3.8k lines.

### 1.2 Why it keeps breaking

Two layout engines have to agree on every line wrap: the native textarea and the
mirror div. They cannot be guaranteed to agree when there are scrollbars,
fractional zoom, font fallback, chips, or IME preedit. History of the same class
of bug: #1128, #1140 (menu does not follow the caret), #2366 (colour/caret at chip
boundaries), the IME caret-snapping fix, and the 2026-11-10 scrollbar wrap.

**2026-11-10 reproduction** (Storybook `mentions-mentiontwolevelmenu--session-mention-rendering`, Chromium with scrollbars shown):

- **Setup:** three paragraphs of mixed CJK and Latin text in a five-row composer.
- **Width difference:** the textarea's content was 8px narrower than the mirror because of its scrollbar.
- **Result:** at frame widths of 402, 405, 411, 414, 417, 573, 576, 603, 606 and 609px, the textarea's `scrollHeight` was 72px (3 lines) taller than the mirror's.
- **What the user sees:** the caret lands lines below the glyphs being edited. The user's screen recording shows the caret and the IME candidate window one line below the line being edited while typing pinyin.

A scrollbar-inset patch fixes that one case, but the owner rejected it: the class
of bug remains.

## 2. Users and surfaces (risk ranking)

All of the following run this same React composer, so all of them carry the risk:

| Surface                                            | Engine                    | Main risks                                                                              |
| -------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| Electron desktop (macOS, Windows, Linux)           | Chromium                  | Pinyin/Japanese IME, shortcuts, menu placement, autosize                                |
| Android app (Capacitor WebView) and Android Chrome | Chromium WebView          | Gboard composition and predictive text, soft keyboard lift, docked menu, `enterkeyhint` |
| iOS app (Capacitor WKWebView) and iOS Safari       | WebKit                    | Pinyin IME, autocorrect, selection handles, keyboard lift                               |
| Desktop browsers                                   | Chromium, WebKit, Firefox | Same as desktop                                                                         |

These are **not affected**: the in-repo native clients `apps/mobile/ios` (Lexical
Swift `ChatComposerView`) and `apps/mobile/android` (Compose `BasicTextField`).
They keep their own composers. They only consume what the web composer sends, and
that format does not change.

## 3. Goals

1. One element paints and edits the text. The caret, selection, IME preedit and
   chips are always on the glyphs being edited, on every surface in §2.
2. Every interaction in §6 behaves the same or better. Every visual in §7 looks
   identical.
3. For the same logical input, the outgoing `text` and `spans` are byte-identical
   to today's. Drafts written by the current build restore in the new one.
4. Delete the textarea, the mirror, the caret clone and the textarea autosize
   measurement. Ship no fallback, flag or second painter.

## 4. Non-goals

- Rich text on web (bold, lists, Markdown shortcuts). The editor makes this
  possible later; it is not in scope now.
- Changing the native iOS or Android composers, the runtime send path, or the
  message schema.
- Cross-device draft sync, or sharing Lexical JSON with iOS.
- Converting plain textareas that have no mentions:
  - the queued message row edit and the ask-question card;
  - the document-selection editor and the visual annotation composer;
  - the diff comment draft and the onboarding first task;
  - the schedule plain prompt and the Agent Role form;
  - the pasted-text/quote editor in `chat-composer.tsx` and the landing crash fallback.

## 5. Anti-goals (fail even if it "works")

- Any CJK, Japanese or Gboard regression:
  - lost, duplicated or reordered characters;
  - a caret jump during composition;
  - a double commit;
  - Enter sending, or a menu committing, while composing.
- Any change to what an Agent receives for the same draft.
- A hidden textarea, a ref object that pretends to be an `HTMLTextAreaElement`, a
  runtime flag that keeps both implementations, or a second text painter.
- Composer growth that shifts the conversation's reading position (the
  `conversation-scroll` contract), or a composer that is visibly slower to mount
  when switching sessions.

## 6. Interaction requirements

Each item is an acceptance criterion. "Same as today" refers to the behaviour
documented in `ui/mention/AGENTS.md`, `components/mentions/AGENTS.md`,
`.agents/docs/ui-mentions.md` and the Specs named below.

### 6.1 Text editing

- **I1 Caret on glyphs.** Typing, IME preedit, selection and caret stay on the
  edited glyphs in all cases:
  - long CJK, Latin and mixed text;
  - after overflow, scrolling inside the composer, window resize and app zoom;
  - with chips at the start, middle and end of a line.
- **I2 Newlines.** Shift+Enter and the platform newline rules behave as they do
  today. A newline is `\n` in the string, never a new paragraph that serializes as `\n\n`.
- **I3 Enter to send.** Enter-to-send, Mod+Shift+Enter inversion, the mobile
  `enterKeyHint` action, and the rule "no send while IME is composing" are unchanged
  (`session-chat-input-area.tsx`).
- **I4 Undo and redo.** Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Ctrl+Y and the
  `historyUndo`/`historyRedo` input types work. A chip and its text move together.
  Payloads referenced by history stay retained (`onHistoryRetainValues`).
- **I5 Placeholder.** Shown only when the editor is empty, with today's colour, and
  never counted in height. The empty-composer prompt suggestion still overlays the
  box, grows it to fit, and is accepted with Tab.
- **I6 Spellcheck and autocorrect.** Spellcheck stays off, as in today's mirrored
  composers, so no new squiggles appear. Mobile autocorrect and predictive text
  must not corrupt chips.
- **I7 Readonly and disabled.** These keep today's semantics, including
  `preservePromptFocus` (focus is kept and input is blocked) while sending.

### 6.2 Mentions and chips

- **M1 Atomic chips.** The caret cannot be placed inside a chip by click, tap,
  arrow keys or focus.
  - Left/Right and macOS Ctrl+B/F cross a chip in one step; Cmd/Ctrl+Arrow jumps by word.
  - Backspace/Delete removes a chip together with its trailing space.
  - Backspace right after that trailing space deletes only the space.
  - Non-collapsed selections may span chips, for copy, replace and delete.
- **M2 Triggers.** `@`, `$`/`￥`/`¥`, `/`/`、` and `#` keep today's rules
  (`findTriggerCandidates`; Specs `command-mention-triggers`, `skill-mention-triggers`):
  - a trigger only follows whitespace or the start of a line (`#` excepted);
  - the query contains no whitespace;
  - commands are offered only when the whole composer is slash-only.
- **M3 Menu keys.** Unchanged:
  - Enter or Tab selects; modified Enter belongs to the owner.
  - Tab or ArrowRight descends; Backspace or ArrowLeft pops the `ns:` prefix in one keystroke.
  - Shift+Tab closes the menu and leaves the mode cycle alone.
  - Up/Down/Home/End move the highlight; Escape closes the menu and stops propagation.
  - The primitive handles keys before the caller does.
- **M4 Insert sources.** These keep today's single splice rule (`applyMentionSplice`),
  `separate` and suffix semantics, and take focus:
  - menu selection (including navigation items and async preparation with
    loading/error rows);
  - `onMentionInsert` batches;
  - `mentionActionsRef` (`insertExternalMention`, `insertSessionMention`,
    `insertPathMentions`);
  - directory drop, session link paste and quote insertion.
- **M5 Hydration and drafts.**
  - Persisted ranges are authoritative; overlapping ranges are dropped.
  - Swapping `draftKey` resets the editor.
  - Clearing the value to empty keeps focus.
  - Multiple hydrators in one flush merge (`useFlushConsistentState`).
- **M6 Click on a chip.** `onMentionClick` fires for the clicked chip (pasted-text and
  quote chips open their editor).
- **M7 Menu placement.** The Spec `composer-mention-menu-placement` holds unchanged:
  - The menu follows the caret through wraps, scroll, resize and scale.
  - The main composer prefers to open above; inline and dialog editors prefer below and flip.
  - `positionAnchor="composer"` locks the side for the whole open.
  - The menu respects `--mention-input-width`.
  - The mobile docked panel sits above `[data-mention-frame]`.
  - Measuring the caret never restyles the whole page.

### 6.3 Clipboard and drop

- **C1 Paste precedence.** The Spec `composer-paste-precedence` holds: files and images
  attach; large text becomes a pasted-text chip; session links become session
  chips; the escape-hatch hint stays. Any remaining text is inserted as plain text.
  HTML is never parsed into the document.
- **C2 Copy expansion.** Copy expands chips as today (a session copies as
  `[@Title](lody://session/…)`), including selections that span chips.
- **C3 Drop.** File and image drop are handled on the container, as today;
  directory drop inserts path chips.

### 6.4 Focus and keyboard integration

- **F1 Focus behaviour.** Existing focus behaviour stays:
  - Cmd+L toggle on landing;
  - container click focuses the editor;
  - focus returns after navigation, submission or a dialog close (`finalFocus`);
  - soft keyboard dismissal after send on mobile.
- **F2 Global composer detection.** Code that identifies the composer must use
  `[data-lody-composer-input]`, not `tagName === 'TEXTAREA'`. This covers:
  - `lib/menu-focus.ts`;
  - `use-chat-landing-keyboard-nav.ts`;
  - `lib/commands/shortcuts.ts`;
  - the onboarding tour camera;
  - focus scopes;
  - keyboard navigation;
  - the mobile drawer.
    Text inputs are still never intercepted by list navigation.
- **F3 Accessibility.** The editor keeps:
  - `role="combobox"` with `aria-multiline="true"`;
  - `aria-expanded`, `aria-controls`, `aria-activedescendant` and `aria-autocomplete="list"`;
  - its label, `aria-invalid` and `required` semantics.
    Screen readers read a chip by its visible label.

### 6.5 Mobile specifics

- **P1 Soft keyboard.** The composer keyboard lift, the docked mention panel above the
  frame, and `mobilePanelPlacement="bottom"` for full-height composers are unchanged.
- **P2 Android input.** Gboard composition, predictive suggestions, glide typing,
  voice input and the emoji keyboard insert text correctly next to chips, at line
  start, mid-line and line end.
- **P3 iOS input.** Pinyin, autocorrect replacement, selection handles, the
  long-press loupe and dictation work next to chips.

## 7. Visual requirements

Identical to today: users must not notice the change. Implementers capture "before" screenshots of the stories below, in
light and dark mode, before changing code, and attach before/after pairs to the
PR. Any visible difference is a defect.

### 7.1 Text and box

- **V1 Typography.** Fonts, sizes, line heights, padding, colours and the placeholder
  colour stay per variant (`getChatComposerTextareaClassName`, `dialogTextareaClassName`
  in `chat-composer.tsx`):

  | Variant | Font size and line height | Padding     | Minimum height            |
  | ------- | ------------------------- | ----------- | ------------------------- |
  | Session | `text-sm leading-6`       | `px-1`      | 48px desktop, 24px mobile |
  | Landing | as today                  | `px-0`      | 120 / 140px               |
  | Sheet   | `text-base leading-7`     | `px-5 py-4` | as today                  |
  | Dialog  | as today                  | `px-4 py-3` | 120px                     |

  All variants use `typography.prompt`, `text-input-foreground` and
  `placeholder:text-input-placeholder/85`.

- **V2 Autosize.** The editor grows from `rows` lines up to `maxRows` (default 12)
  lines plus padding, then scrolls internally with the global thin scrollbar. The
  empty height is exact, with no flash when the first character is typed. Growth
  preserves the conversation's reading anchor. With the textarea gone, the
  textarea measurement code is removed.
- **V3 Selection colour.** The selection uses the system `Highlight`/`HighlightText`
  colours, including across chips.

### 7.2 Chips (baseline: `components/mentions/mention-chips.tsx`)

- **V4 Text-only chips.** Mention chips are colour-only text
  (`MENTION_CHIP_CLASS_NAME`); pasted text is neutral (`MENTION_NEUTRAL_CHIP_CLASS_NAME`).
  `#issue`, `$skill` and `/command` keep their sigils and have no icon.
- **V5 Icon chips.** File and dir use the monochrome file/folder icon by path.
  Session uses `MessagesSquare`, agent_role `UserRoundCog` (and the Role emoji upgrade
  in `combined-mention-textarea.tsx`), pasted_text `ClipboardList`, message_quote
  `Quote`. Icons are sized at `1.05em`.
- **V6 Quote chips.** Quote chips use the filled quote surface: the label colour mixed at
  8% over the elevated background, `radius.mini`, `box-decoration-break: clone` across wraps.
- **V7 No visible change.** Chips keep today's exact appearance and advance
  width, including the figure-space gutter of pasted-text labels. Users must not
  notice the change (owner, 2026-11-10). Drafts with legacy and figure-space
  labels render as today.
- **V8 Selected chips.** A chip inside a selection reads as selected.

### 7.3 Baseline stories

- `ChatComposer.stories.tsx`: all stories, especially `SessionMentionStress`,
  `SessionMentionWideDark`, `SessionLongPrompt`, `LandingWithPastedText`,
  `DialogMentionStress`, `SessionPromptSuggestion*`.
- `MentionChips.stories.tsx`: `PlainHighlight`, `IconChips`, `IconChipsDark`.
- `MentionTwoLevelMenu.stories.tsx`: `SessionMentionRendering`, `FloatingInComposer`,
  `MainComposerAboveFrame`, `MainComposerRoleCatalogAtCaret`,
  `FloatingComposerAtTop`, `PreparedShortcut`, `SkillCategoryMobile`.
- `MessageQuotes.stories.tsx`, `SessionChatInputArea.stories.tsx`,
  `MobileChatLandingScreen.stories.tsx`, `ChatLandingView.stories.tsx`,
  `ScheduleMentions.stories.tsx`, `DraftSessionChatInterface.stories.tsx`.

## 8. Technical design

### 8.1 Decided

- **D1 Editor.** Use Lexical (`lexical`, `@lexical/react`, `@lexical/history`,
  `@lexical/utils`, and `@lexical/plain-text` or an equivalent minimal plain-text
  plugin).
  - Pin one exact current stable version in `packages/components` and update
    `pnpm-lock.yaml`.
  - Web does not share Lexical JSON with iOS (the iOS fixtures pin 0.49), so the
    versions need not match.
- **D2 Document shape.** The root holds exactly one `ParagraphNode`, which contains
  only `TextNode`, `LineBreakNode` and the Lody mention node. Enter and paste never
  create a second paragraph.
- **D3 String boundary.** The composer's external model stays as today: a plain string
  plus UTF-16, half-open `Mention` ranges `{start, end, value, kind}`.
  - Two pure functions are the only place offsets are computed:
    `toComposerValue(editorState) → {text, mentions}` and
    `fromComposerValue({text, mentions}) → nodes`.
  - A mention node serializes to exactly today's inserted wire text: `@path`,
    `#123`, `$skill`, `/cmd`, session/role tokens, the pasted-text label and the
    quote text.
  - Invalid or overlapping ranges are dropped exactly as `sanitizeMentionRanges`
    does.
- **D4 Owner control.** The owner still controls the string.
  - When an external value differs from the editor's serialization, the editor
    content is rebuilt and the caret is restored by offset.
  - An equal value is a no-op.
  - No external write is applied during composition.
- **D5 Explicit handle.** `forwardRef<HTMLTextAreaElement>` is replaced everywhere
  by `ComposerInputHandle`:
  - `focus(options)`, `blur()`, `element` (the contenteditable);
  - `getText()`, `getSelection() → {start, end}`, `setSelection(start, end)`;
  - `isComposing()`.
    Types force every caller in §9 to migrate. No caller reads `.value`,
    `.selectionStart`, `setSelectionRange` or `scrollHeight` any more.
- **D6 What is kept.** The `Mention` root (menu state, triggers, registry,
  preparation, inserts, `onNavigateBack`, flush-consistent updaters),
  `mention-input-core.ts` (range algebra), menus and surfaces, hydrators, and the
  chip resolver are kept.
- **D7 What is deleted.** `mention-input.tsx`'s textarea, caret clone and glue;
  `mention-highlighter.tsx`; `chat/textarea-measurement.ts`; the textarea
  autosize; and the dead `FileAtMentionTextarea`.
- **D8 Menu anchor.** The anchor is the client rect of the collapsed DOM selection
  range, with a line-height fallback on empty lines. The editor element is the
  floating-ui `contextElement`.
- **D9 Wire format.** The outgoing wire format is unchanged: a `text` input block
  plus strict `MessageTextSpan[]`, produced by today's `useMentionPromptExpansion`.
- **D10 Draft storage.** Local draft storage is unchanged (string, pasted drafts,
  mention ranges, quote drafts), and there is no migration.
- **D11 Rollout.** The change ships in one go, with no runtime flag. It merges only
  after §10 passes.

### 8.2 Decided by a gate in step 1: the mention node type

- **Preferred:** an inline `DecoratorNode` that renders the chip through `getMentionChip`.
  It is atomic by construction and is the common Lexical mention pattern.
- **Alternative:** a `TextNode` in token mode, styled by class, the shape iOS ships as
  `ChatReferenceNode`. It leaves fewer `contenteditable=false` islands, but icons must
  be pure CSS.
- **Gate:** run the IME cases in §10.3 with a chip at line start, mid-line and line end.
  Use Chromium (CDP `Input.imeSetComposition`), WebKit, an Android emulator with
  Gboard, and an iOS simulator with pinyin. The decorator wins if it passes;
  otherwise use token text. Record the result and evidence in this note. The
  serializer contract (D3) is the same either way.

### 8.3 Left to the implementer

- Component and file names; whether `CombinedMentionTextarea` is renamed.
- Whether undo uses Lexical history directly or today's snapshot stack over the
  string boundary, provided I4 holds.
- How `rows` and `minHeight` are expressed in CSS.
- How the existing tests are split between pure unit tests and Playwright.

## 9. Callers to migrate

- `chat/chat-composer.tsx`: the session, landing, sheet and dialog variants; autosize;
  prompt suggestion; copy; quote caret.
- `sessions/session-chat-input-area.tsx`: quote caret tracking, pasted-text insert,
  paste and drop, the imperative handle, `finalFocus`, and the submission focus
  helpers under `chat/submission/`.
- `chat/chat-landing.tsx` and `chat/chat-landing-view.tsx`: Cmd+L, pasted-text insert,
  the mobile new-chat sheet, and the paste handler.
- `schedules/schedule-mention-form.tsx` and `schedule-view.tsx` `renderPrompt` typing;
  `schedules/scheduled-message-editor.tsx`.
- `ai-gui/user-message-editor.tsx` (edit and resend: `rows=1`, Escape cancels,
  Mod+Enter saves, quote atoms, autosize).
- `settings/prompt-shortcuts-setting.tsx` and `prompt-shortcut-form.tsx`.
- The global selectors listed in F2.
- The rules being retired: rewrite the textarea-specific rules in
  `ui/mention/AGENTS.md`, `components/mentions/AGENTS.md`, `.agents/docs/ui-mentions.md`
  and the `mention-chips.tsx` header to describe the editor. Update the Evidence links in
  the Spec `composer-mention-menu-placement`.

## 10. Verification and acceptance

### 10.1 Golden wire fixtures (before the swap)

Capture fixtures from the current implementation as `{draft → text, spans}`. Cover:

- every mention kind;
- quotes and pasted text;
- CJK text, emoji surrogate pairs and newlines;
- chips at line edges and adjacent chips;
- drafts with the legacy and the figure-space pasted labels.

The new composer must reproduce them exactly. These fixtures are the native
compatibility proof.

### 10.2 Unit tests (vitest, pure)

- Serializer round trip and offset properties.
- Range sanitization.
- Trigger detection over the serialized text.

### 10.3 Browser tests (Playwright on Storybook)

Run on Chromium and on `LODY_E2E_BROWSER=webkit`. Rewrite these against the editor:

- `composer-mention-placement`, `message-quotes`, `composer-submission-focus`,
  `interface-typography`.

Add tests for:

- long overflowing CJK text, where the caret rect lies on the glyph rect of its offset, with scrollbars shown;
- IME composition through CDP: preedit, commit, cancel, and Enter during composition;
- chip boundaries and deletion;
- undo and redo;
- paste precedence and copy expansion;
- autosize growth and the reading anchor;
- menu placement.

Component tests that drove the textarea with `setNativeValue` or `setSelectionRange`
(17 files) move to the handle or to Playwright. Shallow tests are deleted, not
ported.

### 10.4 Device acceptance

Record a short screen recording per row and attach it to the PR.

| Surface                                       | Must pass                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Electron desktop (macOS)                      | §6 and §7, with macOS pinyin IME                                                            |
| Android emulator, Chrome or Capacitor WebView | Gboard pinyin and English predictive, glide and voice, keyboard lift, docked menu, send key |
| iOS simulator, Safari or Capacitor            | Pinyin, autocorrect, selection handles, keyboard lift, docked menu                          |
| Native iOS app                                | Opens, renders and edits a turn sent from the new web composer with every chip kind         |
| Native Android app                            | Same as native iOS                                                                          |

### 10.5 Repository checks

`pnpm check`, `pnpm format`, `pnpm check:public-boundary` (a new dependency) and
`pnpm run docs check`.

## 11. Delivery plan

The change lands as one PR. It may be developed as a stack, but it merges
together, so main never holds two composer implementations. Steps:

1. Capture the golden fixtures and baseline screenshots (§10.1, §7.3).
2. Build the editor primitive, the serializer and the node-type gate (§8.2) in Storybook.
3. Migrate the primitive's internals and every caller (§9). Delete the old code (D7).
4. Rewrite the tests and docs (§9, §10.2, §10.3).
5. Run device acceptance (§10.4). After independent review, merge.

## 12. Risks

| Risk                                                            | Mitigation                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Android Gboard composition next to non-editable inline elements | The §8.2 gate, the token-text alternative, and device acceptance            |
| WebKit caret at a chip on a line edge                           | The gate, and the WebKit Playwright project                                 |
| Offset drift between the editor and the string model            | One pure serializer, property tests and golden fixtures                     |
| Large caller migration                                          | Types force it (D5); one PR with full checks                                |
| Bundle size                                                     | Lexical core plus React bindings are small; report the size delta in the PR |

## 13. Owner decisions (2026-11-10)

- Replace with a stable editor framework; Lexical is acceptable. No more patches:
  the scrollbar-inset fix is not merged.
- The risk is on the web composer surfaces: desktop and Android, because Android
  in practice runs this web composer, plus iOS web shells. The native in-repo
  clients are kept compatible without code changes.
- Interaction and styling must be equal to or better than today.
- Later the same day the owner tightened this: users must not notice the change
  at all, so no visual "improvements" ship (V7). The owner then asked this agent
  to implement the PRD itself.
- This document is the PRD; other agents implement it.

## 14. Alternatives considered

- **Keep the mirror and patch each mismatch:** rejected by the owner, because the class of bug remains.
- **ProseMirror directly:** equally capable. Lexical was chosen because iOS already
  ships a Lexical model and the owner accepted it.
- **Tiptap:** adds a rich-text abstraction over ProseMirror that this plain composer does not use.
- **A textarea-compatible ref facade:** rejected as a hidden fallback.

## Evidence

- **Current primitive:** `packages/components/src/ui/mention/` (`mention-input.tsx`,
  `mention-highlighter.tsx`, `mention-root.tsx`, `mention-input-core.ts`).
- **Composer:** `packages/components/src/components/mentions/combined-mention-textarea.tsx`,
  `mention-chips.tsx`, `packages/components/src/components/chat/chat-composer.tsx`.
- **Wire format:** `packages/shared/src/message-schemas.ts`, `message-text-spans.ts`,
  `message-quote.ts`.
- **Native clients:**
  - iOS: `apps/mobile/ios/packages/LodyKit` (`ChatComposerView`, `ChatReferenceNode`)
    and `apps/mobile/ios/docs/superpowers/specs/2026-09-29-lexical-swift-composer-design.md`;
  - Android: `apps/mobile/android` (`chat/ChatScreen.kt`, `chat/MentionPresentation.kt`).
- **Reproduction:** measured as described in §1.2. Not committed: the patch was
  rejected by the owner.
