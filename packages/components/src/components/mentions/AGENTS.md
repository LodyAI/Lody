# src/components/mentions

Product-level mention sources built on `src/ui/mention`.

Read [mention-behavior.md](mention-behavior.md) before changing source activation,
hydration, persisted ranges, session/Role addressing, or transcript semantics.

## Invariants

- Disabled categories remain discoverable with localized reasons; they neither
  activate sources nor accept selection. Disabled differs from absent and loading.
- `/` groups independent Shortcut and ACP sources. ACP alone owns the whole
  prompt; Shortcuts can appear inline. Never put Shortcut data into agent caches.
- Restore ranges as data; text hydration only fills unclaimed ranges. Draft swaps
  reset ranges synchronously by `draftKey`; all hydrators preserve existing ranges.
- Stable range IDs own session/Role/Shortcut meaning. Never infer an invocation
  from its visible token. `useMentionPromptExpansion` owns both send paths.
- Lazy source activation is menu-scoped and freshness-aware, never a body prefetch.
- Locale files use flat dotted keys. Template editors exclude Shortcut/ACP nesting.

## Files

- `mention-prompt-shortcut-source.tsx` filters the protected catalog INDEX only.
  It has no body loader: default results require `available`; exact unavailable
  matches are disabled diagnostics. Unverified dependencies remain `unknown`.
  Shortcut ids and ACP ids are distinct; template editors exclude both kinds.

- `combined-mention-textarea.tsx` combines sources, hydrators, triggers, and
  `MentionInput` for chat composer usage.
- `file-at-mention.tsx` and `mention-project-file-source.ts` provide file path
  indexing and `@` candidates.
- `mention-registry.ts` holds the two-level menu contract: category definitions,
  candidate building, and `selectMentionMenuView`.
- `mention-two-level-menu.tsx` renders that contract as the single `@` menu and
  owns the activation latch and the `menu_open` -> `category_enter` -> `select`
  funnel, both through `hooks/use-fire-once` rather than private refs.
  `category_enter` is reported from the resolved view, not a row callback: a
  navigation item never fires `onMentionSelect`, and the keyboard route counts.
- `mention-session-source.ts` owns session slugs, candidates, the slug -> id
  cache, hydration, the drop-time insertion, and the before-send expansion.
- `mention-agent-role-source.ts` owns the Agent Roles work-context rule,
  candidates, hydration, and the before-send rewrite. `useAgentRoleMentionItems`
  is the single owner of the mentionable list, like `useSessionMentionItems`:
  the menu and expansion both read it. It reads the visible-machine index, so a
  test that renders a composer stubs it the same way it already stubs the
  session source.
- `mention-expansion.ts` composes every before-send transform into one hook.
  Which kinds it rewrites is the short list (`REWRITTEN_SPAN_KINDS`); the
  verbatim ones are derived from `MESSAGE_TEXT_SPAN_KINDS` minus it, so a new
  span kind is a type error here rather than a mention that silently stops
  getting a transcript chip.
- `mention-hydration.ts` owns the hydrate-the-initial-text-once effect, the
  range merge every source shares, and `forEachAtTokenSpan` — the single
  definition of where an `@` token ends. Both the file and session hydrators
  scan with it; they have to agree, because the session one decides what it may
  claim by asking the file source which tokens it already knows.
- An invocation chip is atomic and stays a chip: there is no "expand and edit"
  that lowers one back into editable text. So the draft carries no generated
  variable markers and no literal ranges, and nothing but a chip's own values can
  block send. To change the template itself, edit the Shortcut in Settings.
- `shortcut-prompt-compilation.ts` compiles snapshot segments with stable-target
  lowering, then sends those and ordinary original-coordinate rewrites through
  one `applyTextRewrites` emitter. Variable output is never scanned for tokens.
  Both send paths catch validation failures before hiding or clearing the draft.
- `use-shortcut-composer-draft.ts` adds account/workspace/composer-scoped local
  recovery only for Shortcut drafts. The checkpoint pairs text/ordinary ranges
  with snapshots because session text caches do not survive refresh. Restore
  through existing owner callbacks, never a DOM/component-ref handoff; edits
  fence pending reads by generation. `lib/shortcut-composer-draft.ts` serializes
  durable writes and exposes clears synchronously for accepted child promotion.
  Every identity transition creates a new restore ticket, including returning to
  a previously ready key. `draftSuspended` pauses checkpoint writes and the
  empty-input reset while a pending send only hides the prompt: rejected sends
  must keep the original invocation data. Accepted sends clear before promotion.
  Landing/session owners mask Shortcut-bearing cached
  text from foreign account/workspace domains without replacing normal caches.
- An invocation chip is atomic and carries only `/slug`. A Shortcut has no
  variables, so there is nothing to fill in and no parameter surface at all;
  `!{name}` inside a template is ordinary text, stored and sent as written.
- `shortcut-invocation-status.tsx` says why an inserted chip cannot be sent. The
  snapshot is frozen, so what changes under it is the live context — machine
  offline, project changed, reference no longer readable — and it reports that
  upward so the send button and the notice cannot disagree.
- `shortcut-composer-state.ts` derives scope from composer project/provider identity.
  Invocation snapshots live on each `prompt_shortcut` range, keyed by invocation
  id; never reconstruct them from the visible slug or the live catalog.
- `mention-chips.tsx` owns the kind -> glyph and kind -> colour tables for BOTH
  chip surfaces. The composer's resolver decides only slot geometry and the
  transcript's chip only its layout, so `@src/a.ts` cannot look like two
  different objects before and after it is sent.
- `message-text-chips.tsx` paints the transcript's chip as INLINE text, never an
  `inline-flex` box: an atomic inline cannot break, so a long path was pinned to
  one line and lost its file name to `truncate`. The glyph is bound to the first
  few label characters with `white-space: nowrap` — every engine offers a break
  beside an atomic inline and a WORD JOINER does not stop it, so without that
  group the glyph strands at the end of the previous line. Only the pasted-text
  chip stays boxed; it is a `<button>` with a short, fixed label.
- `mention-fuse.ts` owns the shared, module-cached `fuse.js` import. Keep it
  module-cached and keyed by menu activation, and reuse provider file entries
  when paths/lazy dirs are unchanged — the menu must not rebuild either from
  per-render derived objects. The keying is latched, so closing the menu must
  not drop the constructor and re-index everything on the next `@`.
- `issue-pr-hash-mention.tsx` provides cached GitHub issue/PR lookup, ranking,
  hydration, and post-insert title hints.
- `mention-skill-source.tsx` provides `$` skill discovery, provider directory
  filtering, hydration, and the before-send prompt expansion.
- `mention-analytics.ts` centralizes mention analytics event helpers.
