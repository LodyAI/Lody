# src/components/mentions

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Mention sources on `src/ui/mention`. Files: [README.md](README.md).
Pipeline background: [ui-mentions.md](../../../../../.agents/docs/ui-mentions.md).

## Triggers, menu, and candidates

- `@` opens the two-level menu; `$` keeps Skills; `/` groups ACP and Shortcuts.
  `#` opens no menu but retains hydration/expansion.
- `enableAtMentions` is the ONE list of what `@` reaches, gating both trigger
  registration and mounting `<Mention>`; every source with its own `enabled`
  rule (sessions: having any) belongs there too. Placeholder hints advertise `$`
  only under the conditions that enable Skill mentions.
- Desktop `MentionContent` stays capped at `var(--mention-input-width)`.
- `insertText` must keep its type's prompt form (`@path`, `#123`, `$token`,
  `/cmd`): reaching a type through `@` must not change what the agent receives.
  Directory candidates carry BOTH `navigateText` (`@dir/`, descend) and
  `insertText` (`@dir`, commit).
- `MentionCategory.getCandidates` stays lazy: a query scoped to one category
  never ranks files for other categories; bare `@` calls none. Aggregate results
  are capped by `selectMentionMenuView`; the Role category lists all readable Roles.
- Issues and PRs rank over their own slice of the shared cache, partitioned once
  by `useMentionCategories`.
- File, Session, Agent Role, Issue, and PR candidates use the vendored VS Code
  `scoreFuzzy` with non-contiguous matching, wrapped by any source-specific
  ordering. Skills and commands keep their own ranking.
- `MentionCandidateDetail` fields render verbatim: supply i18n text, not enums.
  `detail.agentRole` uses the shared desktop-only Role pane with fixed height
  and stable scrollbar gutter.
- `MentionCategory.activation` starts synchronously via `onMentionNavigate`;
  `selectMentionViewActivations` covers typed/direct/aggregate entry. Both share
  one activation latch per menu-open and `sourceKey`, without source-specific menu logic.
- Activation ensures loading, not revalidation. Issues/PRs use `ISSUE_PR_FRESH_FOR_MS`
  and persist fetch time; only explicit refresh passes `force: true`. Unasked
  sources report `loading`, never ready/empty.

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

- `$` tokens end at whitespace. Known tokens expand to `use /token [Skill Path](path)`;
  project paths are relative, home (`global`/`system`) paths CLI-provided absolute.
  Order project → global → system with `compareProjectSkillScope`.
- Candidates come from `useProjectSkills`, never Codex's registry. One CLI home
  scan supplies global/system scopes filtered by `getRegisteredGlobalSkillDirs` /
  `getRegisteredSystemSkillDirs`. `~/.agents/skills` is provider-specific; support
  flat and catalog layouts but exclude unregistered roots. Registered empty
  whitelists stay empty; unknown agent types use `null`, not an empty `Set`.

## Sessions

- `useSessionMentionItems` owns child-inclusive `allActiveSessions`, excluding
  archived/own sessions. Project filtering is menu-only: never filter hydration,
  expansion, drops, slug lookup, or child addressing by menu scope.
- Commit plain `@<title-slug>` with `sessionId` on its range. Expand THE RANGE
  into the id-bearing MCP instruction; unclaimed tokens stay verbatim. Session
  hydration skips tokens known by the file source.
- Resolve slugs live first, then the synchronous localStorage slug→id map;
  register its key in `clear-local-cache.ts` and skip unchanged writes.
- Sidebar/tab drops use `mentionActionsRef.insertSessionMention(sessionId)` to
  create a real range; unknown/own/duplicate sessions return false. Draft and
  file/diff tabs are not sources. Paint ONE `ConversationDropOverlay` through
  `SessionMentionDropLayer` per conversation column, never per keep-alive tab.

## Agent Roles

- Commit plain `@<token>` with the Role id on its range; expansion requests Session
  creation with that id only (shared contracts own acceptance/freezing). Unavailable
  Roles stay plain text at send. Derive names/uniqueness via `getAgentRoleMentionSlug`.
- `MentionCandidate.iconEmoji` replaces the category glyph via `getAgentRoleEmoji`;
  omit detail title. `applyAgentRoleEmojiChip` clips the committed glyph to its slot;
  `AgentRoleMentionItem` carries config and machine for the pane.
- Check visibility, executability, then work context. Local Project/localWorktree
  pins a machine; plain/GitHub contexts may use authorized machines. List readable
  unavailable Roles after available matches with reasons. Only available Roles
  select, hydrate or expand; never fall back.

## Prompt Shortcuts

- Disabled categories stay discoverable with localized reasons but cannot activate
  or commit. Template editors exclude Sessions, recursive Shortcuts and ACP commands;
  explicit scope owns discovery and text-scanning hydrators remain disabled there.
- Shortcut discovery reads only the index. Default results require `available`;
  exact unavailable matches are disabled diagnostics and unverified dependencies
  remain `unknown`. Body loading belongs to cancellable selection, never menu open.
- Shortcut and ACP ids are distinct. ACP owns a whole slash-only prompt; Shortcut
  chips can appear inline. Never put Shortcut data into machine capability caches.
- Invocation snapshots live on `prompt_shortcut` ranges keyed by invocation id,
  never reconstructed from visible slugs. Chips are atomic, have no parameters or
  expand-and-edit action, and `!{name}` is literal text. Scope/dependency status,
  not variable values, can block sending.
- `shortcut-prompt-compilation.ts` lowers snapshot segments and ordinary original-
  coordinate rewrites through one emitter. Both send paths catch failures before
  clearing the draft; history stores the fully expanded Prompt.
- `use-shortcut-composer-draft.ts` supplements ordinary draft owners only for
  Shortcut drafts. Checkpoints pair text/ranges/snapshots under account, workspace
  and composer identity. Generation fences late restores, including return to an
  earlier identity; restores use owner callbacks, never component-ref handoffs.
- Pending sends suspend checkpoint writes and empty-input resets; rejection keeps
  invocation data and acceptance clears before child-tab promotion. Identity swaps
  remount the mention root; clearing text only resets data and hydrators, preserving
  the textarea DOM and focus as well as semantic undo history.
