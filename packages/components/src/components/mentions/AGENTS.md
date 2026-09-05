# src/components/mentions

Product-level mention sources built on `src/ui/mention`.

## Invariants

- `@` reaches every mention type through the two-level menu. Skills also retain
  their direct `$` menu for compatibility, and `/` still opens commands
  directly because a slash command must own the whole prompt. `#` does not open
  a menu, but its hydrator remains so hand-typed or pasted `#123` is highlighted
  and expands before send.
- Desktop mention menus should render through `MentionContent` and cap width with
  `var(--mention-input-width)` so menus stay inside the composer/input range.
- `$` skill tokens must remain whitespace-free; hydration scans from `$` to the
  next whitespace.
- `$` skill candidates come from `useProjectSkills`, not Codex's runtime skill
  registry. One CLI `list-global-skills` home scan returns two scopes: `global`
  (user-authored, over `ALL_KNOWN_GLOBAL_SKILL_DIRS`) and `system` (agent
  built-ins, over `ALL_KNOWN_SYSTEM_SKILL_DIRS`, e.g. `~/.codex/skills/.system`),
  each filtered by the provider's `getRegisteredGlobalSkillDirs` /
  `getRegisteredSystemSkillDirs`. `~/.agents/skills` is a provider-specific
  alias, not a universal fallback: only providers with verified support register
  it. The scanner handles flat `~/<agent>/skills/<skill>/SKILL.md` and catalog
  `~/<agent>/skills/<category>/<skill>/SKILL.md`; paths outside the provider's
  registered roots (e.g. plugin caches) appear only once their dirs are added.
- A registered entry mapping to no dir (`deepagents`) keeps its empty
  whitelist; an unregistered agent type gets `null` instead, because an empty
  `Set` here filters every candidate out rather than restricting nothing.
- Before send, known `$` skill tokens are expanded in prompt text to
  `use /token [Skill Path](path)`. Project skills use their project-relative
  `SKILL.md` path; home-scoped (`global` + `system`) skills use the CLI-provided
  absolute `SKILL.md` path. Display order is project → global → system
  (`compareProjectSkillScope`).
- Hydrators should only add ranges for known tokens/items and should preserve
  existing external `pasted_text` mention ranges. Every hydrator must record a
  `kind` — `HydratedMentions` requires it — because both the chip resolver and
  the before-send rewrite dispatch on it, so a kindless range renders without
  its icon and, for sessions, silently stops expanding.
- A composer stores its mention ranges with its draft and restores them through
  `PersistedMentionHydrator`. Rebuilding from text is the fallback, not the
  mechanism: it needs the source loaded, so a mention spent every return looking
  like plain text and never came back at all if the source never loaded. Store
  the narrow `PersistedMentionRange`, never the live range — that carries
  callbacks, which `JSON.stringify` writes as `{}`. What makes it a fallback is
  `mergeHydratedMentions`: a hydrated range that OVERLAPS one already present is
  dropped, not just an exact duplicate. Since a session and a path are now the
  same shape, two sources can each claim `@fix-ci` at different ends, and only
  rejecting overlaps keeps the restored range authoritative.
- A composer that swaps drafts in place (the session one does — it switches
  session without remounting) must pass `draftKey`. Otherwise a swap is
  indistinguishable from a very large edit: the outgoing draft's ranges stay
  committed and land on the incoming text at their old offsets, and hydration —
  which arms once per mount — has already fired, so the incoming draft's own
  mentions never appear. The reset runs during render, so the stale ranges are
  never painted, not even for a frame.
- Hydration latches the first NON-EMPTY text, not the first render's. A
  persisted draft is not there on mount: `atomWithStorage` initialises with its
  default and reads storage in `onMount`, so latching at mount latches `''` and
  the "only hydrate the text I measured" guard never passes again.
- A `MentionCandidate`'s `insertText` must keep its type's existing prompt form
  (`@path`, `#123`, `$token`, `/cmd`). Reaching a type through `@` must not
  change what the agent receives.
- `MentionCategory.getCandidates` stays lazy. Ranking the file index is the
  expensive one, so a query scoped to another category must never call it, and a
  bare `@` must call none of them. Its `limit` is a hint a source may honour to
  stop early; `selectMentionMenuView` still enforces the cap, so a source that
  ignores it stays correct.
- Issues and PRs rank over their own slice of the shared cache. The shared
  ranking caps its result set, so ranking the merged list first lets a long issue
  list starve every PR out of the PR category. The slices are partitioned once by
  `useMentionCategories`, not re-derived per keystroke.
- Every category caps its candidate count. A row is a registered collection item
  that arrow-key movement walks, so an uncapped source degrades navigation, not
  just render time.
- File, Session, Agent Role, Issue, and PR candidates use the vendored VS Code
  `scoreFuzzy` algorithm with non-contiguous matching enabled: a query may skip
  words, spaces, and punctuation, while consecutive, separator, path, case, and
  camel-case matches receive the same bonuses as VS Code. Existing
  source-specific ordering rules still wrap the shared fuzzy score. Skills and
  commands retain their own ranking.
- Lazy work is `MentionCategory.activation`; category navigation starts its
  destination synchronously through `MentionItem.onMentionNavigate`, while
  `selectMentionViewActivations` covers typed/pasted prefixes, direct triggers,
  and aggregate views. It says which sources a view needs (scoped and aggregate
  do; the category index does not). Both routes share the menu's "once per
  menu-open cycle" latch; the menu owns no source-specific rule.
  Categories on one source share its `sourceKey`, so the pair activates once
  despite `activate` being an identity-churning callback. Skills activate this
  way too; the draft-contains-`$` scan remains only for the hydrator.
- Activation means "make sure this is loaded", not "revalidate": an aggregate
  query activates every category, so an unconditional refetch bills a mention
  aimed elsewhere. Issues/PRs gate on `ISSUE_PR_FRESH_FOR_MS`; explicit gestures
  pass `refresh({ force: true })`. The fetch timestamp rides on the cached entry,
  like the file source's `fetchedAt`, so it survives the IndexedDB round trip —
  beside it, every reload would look unfetched and refetch on the first `@`. An
  unasked source reports `loading`, not `ready` with zero rows.
- `enableAtMentions` is the one list of what `@` reaches, gating both trigger
  registration and mounting `<Mention>`. Every source with its own `enabled`
  rule (sessions: having any) belongs there too, or the composer falls back to a
  plain textarea and drops that type.
- Composer placeholder hints advertise `$` only when the same project-source or
  machine-source conditions enable Skill mentions. Plain-agent chats with a
  machine can therefore advertise `$` without falsely advertising `@`.
- A session mention commits as a plain `@<title-slug>`: no `session:` marker,
  because it was only ever an anchor for the before-send rewrite and the user
  had to read it. The mention range carries the real `sessionId`, and
  `useMentionPromptExpansion` rewrites **the range** — not a text match — into
  an id-bearing MCP instruction on send. It is still the only type whose
  displayed text differs from what the agent receives.
- A session dragged out of the sidebar **or a session tab** onto a chat surface
  becomes a mention of it. The drop must produce a REAL range, not just
  `@<slug>` text — a token with no range is sent verbatim (below), so a
  text-only append would look right in the composer and reach the agent as a
  word. The route is `CombinedMentionTextarea`'s `mentionActionsRef`
  (`insertSessionMention(sessionId)`) onto the primitive's `onMentionInsert`;
  it takes an ID because `useSessionMentionItems` stays the single owner of the
  list, and it returns false — insert nothing — for an unknown/own session or
  one the draft already mentions. Transfer format and the self-drop check live
  in `lib/session-mention-drag.ts`. Sidebar rows and the parent tab use HTML5
  drag; child session tabs share the strip's dnd-kit pointer drag (a drop on
  another tab still reorders; a drop on the conversation mentions). Draft and
  file/diff tabs are not mention sources. The conversation COLUMN paints one
  `ConversationDropOverlay` via `SessionMentionDropLayer`. Do not put that mask
  inside each keep-alive tab page: hidden panes and draft tabs make a per-page
  overlay vanish or stack on the wrong surface.
- An Agent Role mention is the session mention's shape — a plain `@<token>` whose
  committed RANGE carries the stable Role id — with a different payload. The
  rewrite asks the agent to CREATE a Session and carries the Role id only. The
  MCP create path resolves that id from the current workspace catalog before it
  accepts and freezes the Operation. A Role the composer no longer offers stays
  plain text and produces no create instruction.
- A Role candidate's emoji REPLACES the category glyph (`MentionCandidate.iconEmoji`),
  defaulted through `getAgentRoleEmoji` so rows stay aligned and a Role with none
  does not read as half-authored. The category header above already says these
  are Agent Roles, so a second generic glyph only crowds out the Role's own mark.
  The Role's pane heads itself with that same mark, so its candidate sets no
  detail `title` — the field is optional for exactly that reason.
- The COMMITTED range shows that emoji too, through `applyAgentRoleEmojiChip`:
  the composer wraps the caller's chip resolver, because a range carries only the
  Role id and only the composer holds the live catalog. The emoji is boxed to the
  icon slot and clipped — the slot covers ONE character of real text and an emoji
  glyph is wider than a latin one.
- The transcript shows it from `MessageTextSpan.mark`, FROZEN with the span at
  send time rather than resolved from the catalog when the bubble renders. A sent
  message shows the Role as it was, so renaming or re-marking it later cannot
  repaint history, and painting a bubble never waits on a mutable catalog. A span
  field must be declared in BOTH `sanitizeMessageTextSpans` and the strict
  `MessageTextSpanSchema`: that schema is `.strict()` and a rejected span fails
  the whole block list, so the send path answers a real message with "please
  enter something to discuss" rather than dropping one chip.
- The token is DERIVED from the Role's name (`getAgentRoleMentionSlug`), not a
  second authored field: a Role has one label, and keeping "name" and "mention
  name" in sync is a chore with no payoff when the range carries the id anyway.
  Renaming therefore renames the mention, and name uniqueness is checked on the
  derived token so two names that complete identically cannot coexist.
- `agent_role` is the one span kind the message COPY button collapses back to its
  label (`getCopyTextFromMessageItems`). Its rewritten region is an instruction
  addressed to this agent and means nothing pasted elsewhere, while the chip on
  screen says `@Reviewer`. Edit-and-resend still reads the expanded text through
  `getTextContentFromMessageItems`: a token with no committed range would reach
  the agent as a word.
- Role candidates pass visibility, executability, then work context. Local
  Project (and V1 plain chat) is pinned to its own machine; a GitHub project may
  reach any authorized machine, because the target Session clones the repo
  itself — but one already checked out (`localWorktree`) is pinned like a local
  one. An unavailable Role stays in Settings with its exact reason and is never a
  submittable candidate: no fallback machine, provider, or model.
- A session token with no committed range is sent verbatim. A stale token the
  agent can ignore beats a confidently wrong session id, so the rewrite never
  resolves a slug itself.
- Dropping the marker makes a session and a path the same shape, so hydrating a
  reloaded draft has to break the tie: `hydrateSessionMentionsFromText` skips
  any token the file source already knows. Paths are the common case, and
  mistaking one for a session silently turns a file reference into a history
  query, where the reverse only leaves a token unexpanded — which the user can
  see.
- Session slugs resolve through the live list first, then a `localStorage`
  slug -> id map. The store is synchronous on purpose: expansion runs on the
  send path, and an async store would make that whole path async. Its key is
  registered in `lib/clear-local-cache.ts`, and the write is skipped when the
  serialized map is unchanged — the session list ticks several times a second
  while an agent streams, and `setItem` blocks.
- `useSessionMentionItems` is the single owner of the mentionable-session list.
  The composer and `useMentionPromptExpansion` are both mounted on a session
  screen, so deriving items separately re-slugged every visible session twice a
  tick. It reads the child-inclusive `allActiveSessions` projection, not the
  `sessionListAtom` sidebar rows that hide child tabs: mentioning is an
  addressing surface, and review/task child sessions are exactly what gets
  referenced. Archived and the composer's own session stay excluded. Project
  scope is a menu-only filter over this complete list: local identity includes
  machine + local project id, GitHub identity is a normalized repo full name,
  and projectless chats group together. Never scope hydration, expansion, drag
  insertion, slug resolution, or child-session addressing.
- `useMentionPromptExpansion` is the single before-send text transform. With two
  send paths, per-type expansion hooks must compose here, not be wired into both.
- A candidate describes its side panel through the neutral
  `MentionCandidateDetail` fields, not its own component, so one pane serves
  every category. An Agent Role is the exception, through `detail.agentRole`:
  it renders `sessions/agent-role-detail-pane.tsx`, the SAME pane the composer's
  Role submenu shows. A Role is one object with one reading — which agent, which
  machine, which values it pins, and its instruction — so the neutral rows were
  a second description of it, and they had drifted: they printed the stored ids
  raw and labelled `runConfig.modeId`, the permission mode, "Reasoning". Its
  agent config and machine therefore ride on `AgentRoleMentionItem`, since only
  the bound agent's published capabilities turn a stored id into a label. That
  pane shows the instruction itself rather than a badge saying one exists, and
  it is what retired the neutral `body` field and made `title` optional — the
  Role was their only producer. The pane is desktop-only: the docked mobile
  strip is too narrow and has no hover to preview with. It keeps a fixed height and reserves
  a stable scrollbar gutter so switching between short and overflowing
  descriptions changes neither the menu height nor text width. Its fields
  render verbatim, so a source must put i18n'd text in them — never a raw enum
  such as a skill scope.
- Locale files are flat dotted-key maps: i18next runs `keySeparator: false`, so
  a nested block never resolves and silently falls back to the inline default.
- `@` directory candidates must carry both `navigateText` (`@dir/`, descend) and
  `insertText` (`@dir`, commit without the trailing slash). The primitive no
  longer infers drill-down from a trailing `/`, so dropping either prop silently
  turns directories into plain one-shot mentions.

## Files

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
- `vscode-fuzzy-score.ts` is vendored from the pinned VS Code source identified
  in its header. Keep Microsoft's copyright header, the adjacent complete MIT
  license, and the generated third-party attribution when updating it.
- `issue-pr-hash-mention.tsx` provides cached GitHub issue/PR lookup, ranking,
  hydration, and post-insert title hints.
- `mention-skill-source.tsx` provides `$` skill discovery, provider directory
  filtering, hydration, and the before-send prompt expansion.
- `mention-analytics.ts` centralizes mention analytics event helpers.
