# Chat landing keyboard control

Desktop chat landing renders a config + composer column that can be operated
without a mouse. It is layered on two pieces:

## `mobile-inline-picker.tsx` - keyboard-operable dropdown

Triggers are real `<button>`s, so Space/Enter open them natively. While open,
the trigger keeps DOM focus and owns the keys: Up/Down move the highlight,
Enter/Space select the highlighted option, Esc closes + refocuses the trigger,
and Home/End jump ends. The highlight is the picker's internal `activeIndex`
(mirrored to the option's `data-active`), not DOM focus, so an external roving
controller can open a picker without moving focus into it. When closed, the
picker ignores arrows so they bubble to the roving controller below.

Searchable pickers auto-focus the search input on open only with
`pointer: fine`, never on touch where it would raise the soft keyboard. The
options list uses the `scroll-pro scrollbar-pro [scrollbar-gutter:auto]`
overlay scrollbar so it does not reserve width.

## `hooks/use-chat-landing-keyboard-nav.ts` - roving controller

`useChatLandingKeyboardNav(rootRef, { enabled })` is scoped to
`rootRef` and mounted from `chat-landing.tsx` for the desktop chat landing's
config + composer column via `WebChatLandingScreen`'s `navRootRef`. It is
enabled when `!isMobile`; touch is untouched. Window-capture `keydown`:

- Arrows do 2D spatial nav between visible enabled option
  `<button>`/`[role=tab]` elements. Up/Down jump to the nearest row in that
  direction then nearest column, Left/Right move within the same row. Arrows
  only act when focus is already inside `rootRef`, so they do not hijack the
  sidebar or page chrome.
- Tab stays native on the landing so focus can leave the config area.
- Space/Enter are left to the focused control's native activation. The
  controller yields all keys whenever any `[aria-expanded="true"]` is present
  and whenever focus is in a text field.
- The composer textarea is not in the arrow ring. It is reached via the
  `session.focusInput` command; pressing it while the textarea is already
  focused leaves focus mode via `focusFirstChatLandingOption`.
- Esc steps out: from the composer to the first option, and from a focused
  option to blur + clear `[data-qs-active]`.

The focused option carries `data-qs-active`; the highlight is an inset primary
ring rule in `../../style/index.css` so overflow-hidden rows and global
focus outline suppression cannot hide it.
