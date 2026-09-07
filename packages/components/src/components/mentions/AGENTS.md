# src/components/mentions

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Product-level mention sources on `src/ui/mention`. Files: [README.md](README.md).
Pipeline background: [ui-mentions.md](../../../../../.agents/docs/ui-mentions.md).

## Triggers, menu, and candidates

- `@` reaches every mention type through the two-level menu. Skills keep their
  direct `$` menu, `/` still opens commands directly, and `#` opens no menu but
  keeps its hydrator, so a pasted `#123` still expands before send.
- `enableAtMentions` is the ONE list of what `@` reaches, gating both trigger
  registration and mounting `<Mention>`; every source with its own `enabled`
  rule (sessions: having any) belongs there too. Placeholder hints advertise `$`
  only under the conditions that enable Skill mentions.
- Desktop menus render through `MentionContent`, capped at
  `var(--mention-input-width)`.
- `insertText` must keep its type's prompt form (`@path`, `#123`, `$token`,
  `/cmd`): reaching a type through `@` must not change what the agent receives.
  Directory candidates carry BOTH `navigateText` (`@dir/`, descend) and
  `insertText` (`@dir`, commit).
- `MentionCategory.getCandidates` stays lazy: a query scoped to one category
  must never rank the file index, and a bare `@` must call none. `limit` is a
  hint; `selectMentionMenuView` enforces the cap. Every category caps its
  candidates.
- Issues and PRs rank over their own slice of the shared cache, partitioned once
  by `useMentionCategories`.
- File, Session, Agent Role, Issue, and PR candidates use the vendored VS Code
  `scoreFuzzy` with non-contiguous matching, wrapped by any source-specific
  ordering. Skills and commands keep their own ranking.
- A candidate describes its side panel through the neutral
  `MentionCandidateDetail` fields, which render verbatim — put i18n'd text
  there, never a raw enum. The one exception is `detail.agentRole`, rendering
  `sessions/agent-role-detail-pane.tsx`: desktop only, fixed height, stable
  scrollbar gutter.
- Lazy work is `MentionCategory.activation`; category navigation starts its
  destination synchronously through `MentionItem.onMentionNavigate`, while
  `selectMentionViewActivations` covers typed/pasted prefixes, direct triggers,
  and aggregate views. Both share the menu's once-per-menu-open latch, the menu
  owns no source-specific rule, and categories on one source share its
  `sourceKey`.
- Activation means "make sure this is loaded", not "revalidate": Issues/PRs gate
  on `ISSUE_PR_FRESH_FOR_MS`, and only explicit gestures pass `refresh({ force:
  true })`. The fetch timestamp rides on the cached entry (survives IndexedDB).
  An unasked source reports `loading`, never `ready` with zero rows.

## Hydration and drafts

- Hydrators only add ranges for known tokens/items, preserve existing external
  `pasted_text` ranges, and must record a `kind`. Hydration latches the first
  NON-EMPTY text, not the first render's.
- A composer stores its ranges with its draft and restores them through
  `PersistedMentionHydrator`; rebuilding from text is the fallback. Store the
  narrow `PersistedMentionRange`, never the live range. `mergeHydratedMentions`
  drops a hydrated range that OVERLAPS one already present, not merely a
  duplicate.
- A composer that swaps drafts in place (the session one does) must pass
  `draftKey`; the reset runs during render.
- Locale files are flat dotted-key maps: i18next runs `keySeparator: false`.
- `vscode-fuzzy-score.ts` is vendored: keep Microsoft's copyright header, the
  adjacent MIT license, and the generated third-party attribution when updating
  it.

## Before-send expansion and transcript

- `useMentionPromptExpansion` is the single before-send text transform where
  per-type hooks compose. `mention-expansion.ts` lists the rewritten kinds
  (`REWRITTEN_SPAN_KINDS`) and derives the verbatim ones from
  `MESSAGE_TEXT_SPAN_KINDS` minus it.
- The transcript chip comes from `MessageTextSpan.mark`, FROZEN at send time,
  never resolved from the catalog at render. A span field must be declared in
  BOTH `sanitizeMessageTextSpans` and the strict `MessageTextSpanSchema`.
- `agent_role` is the one span kind the message COPY button collapses back to
  its label (`getCopyTextFromMessageItems`); edit-and-resend still reads the
  expanded text through `getTextContentFromMessageItems`. Both chip surfaces
  read one kind → glyph and colour table (`mention-chips.tsx`).

## Skills

- `$` tokens must stay whitespace-free; hydration scans from `$` to the next
  whitespace. Known tokens expand to `use /token [Skill Path](path)` — project
  skills with their project-relative `SKILL.md` path, home-scoped (`global` +
  `system`) skills with the CLI-provided absolute path — ordered project →
  global → system (`compareProjectSkillScope`).
- `$` candidates come from `useProjectSkills`, not Codex's runtime registry. One
  CLI `list-global-skills` home scan returns the `global` and `system` scopes,
  each filtered by the provider's `getRegisteredGlobalSkillDirs` /
  `getRegisteredSystemSkillDirs`; `~/.agents/skills` is a provider-specific
  alias, never a universal fallback. The scanner handles flat and catalog
  layouts, and paths outside the registered roots appear only once their dirs
  are added.
- A registered entry mapping to no dir (`deepagents`) keeps its empty whitelist;
  an unregistered agent type gets `null` (an empty `Set` filters everything).

## Sessions

- `useSessionMentionItems` is the single owner of the mentionable-session list,
  reading child-inclusive `allActiveSessions`, not `sessionListAtom` sidebar
  rows; archived and own sessions stay excluded. Project scope is a menu-only
  filter over that complete list — never scope hydration, expansion, drag
  insertion, slug resolution, or child-session addressing.
- A session mention commits as a plain `@<title-slug>` (no `session:` marker);
  its range carries the real `sessionId`, and the expansion rewrites THE RANGE
  into an id-bearing MCP instruction. A token with no range is sent verbatim —
  never resolve a slug — and `hydrateSessionMentionsFromText` must skip any
  token the file source knows.
- Slugs resolve through the live list first, then a `localStorage` slug → id
  map. That store stays synchronous, its key is registered in
  `lib/clear-local-cache.ts`, and the write is skipped when the serialized map
  is unchanged.
- A session dragged from the sidebar or a session tab onto a chat surface
  becomes a mention, and the drop must produce a REAL range, not `@<slug>` text:
  route it through `mentionActionsRef.insertSessionMention(sessionId)`, which
  returns false for an unknown, own, or already-mentioned session. Draft and
  file/diff tabs are not mention sources. The conversation COLUMN paints ONE
  `ConversationDropOverlay` via `SessionMentionDropLayer`, never one per
  keep-alive tab page.

## Agent Roles

- An Agent Role mention has the session mention's shape (plain `@<token>`,
  stable Role id on the committed RANGE), but its rewrite asks the agent to
  CREATE a Session and carries the Role id only (root `AGENTS.md` owns MCP
  create/freeze). A Role the composer no longer offers stays plain text and
  produces no create instruction. The token is DERIVED from the Role's name
  (`getAgentRoleMentionSlug`), never a second authored field: renaming renames
  the mention, and uniqueness is checked on the derived token.
- A Role candidate's emoji REPLACES the category glyph
  (`MentionCandidate.iconEmoji`), defaulted through `getAgentRoleEmoji`, and its
  candidate sets no detail `title`. The committed range shows that emoji through
  `applyAgentRoleEmojiChip`, boxed to the icon slot and clipped; its agent
  config and machine ride on `AgentRoleMentionItem`.
- Role candidates pass visibility, executability, then work context: Local
  Project (and V1 plain chat) pins to its own machine, while a GitHub project
  may reach any authorized machine unless already checked out (`localWorktree`).
  An unavailable Role is never a submittable candidate — no fallback machine,
  provider, or model.
