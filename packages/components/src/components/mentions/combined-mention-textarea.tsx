import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  type MentionFileSourceKind,
  type MentionSurface,
} from '@/components/mentions/mention-analytics';
import {
  buildItemSuggestions,
  IssuePrMentionHydrator,
  IssuePrMentionTitleHint,
  useKnownIssuePrItems,
} from '@/components/mentions/issue-pr-hash-mention';
import { hydrateFileMentionsFromText } from '@/components/mentions/file-at-mention';
import {
  buildSessionMentionInsertion,
  filterSessionMentionItemsByProject,
  getMentionSourceProjectKey,
  hydrateSessionMentionsFromText,
  resolveSessionMentionIds,
  useSessionMentionItems,
  type SessionMentionItem,
  type SessionMentionProjectKey,
  type SessionMentionProjectScope,
} from '@/components/mentions/mention-session-source';
import {
  buildAgentRoleMentionContext,
  hydrateAgentRoleMentionsFromText,
  useAgentRoleMentionItems,
  type AgentRoleMentionItem,
} from '@/components/mentions/mention-agent-role-source';
import { applyAgentRoleEmojiChip } from '@/components/mentions/mention-chips';
import { useMentionHydration } from '@/components/mentions/mention-hydration';
import {
  sanitizeMentionRanges,
  type PersistedMentionRange,
} from '@/components/mentions/mention-persistence';
import { MentionTwoLevelMenu } from '@/components/mentions/mention-two-level-menu';
import {
  buildMentionFileIndex,
  useMentionCategories,
  type MentionCategorySources,
} from '@/components/mentions/mention-registry';
import {
  buildLazyDirectoryToken,
  type MentionFileDataState,
  type MentionProjectSource,
  useMentionProjectFiles,
} from '@/components/mentions/mention-project-file-source';
import {
  SKILL_MENTION_TRIGGER,
  SkillMentionHydrator,
  getAllowedSkillMentionDirs,
  type SkillMentionAgent,
  type SkillMentionItem,
  useMentionProjectSkills,
} from '@/components/mentions/mention-skill-source';
import { getAgentRoleEmoji, type AcpCommandSummary } from '@lody/shared';
import { Mention, MentionInput, MentionLabel, useMentionContext } from '@/ui/mention';
import type { Mention as MentionRange, MentionChipResolver } from '@/ui/mention/index';
import { Textarea, type TextareaProps } from '@/ui/textarea';
import { parseMentionNamespaceSearch } from '@/ui/mention/mention-trigger';
import { getCommandKeybindings, useCommand } from '@/lib/commands';

// ============================================================================
// Two-level `@` menu
// ============================================================================

/**
 * Whether a lazy source has nothing to show yet. `idle` is "nobody has asked",
 * and rendering the category is exactly what asks — so an unasked source reads
 * as loading, never as "No results".
 */
function isLazySourceLoading(status: string, hasData: boolean) {
  return (status === 'loading' || status === 'idle') && !hasData;
}

/**
 * Builds the mention registry from the composer's already-fetched data and
 * renders the single `@` menu.
 */
function TwoLevelMentionMenu({
  fileData,
  fileSourceKind,
  enableFileMentions,
  onLazyDirectoryOpen,
  enableIssueMentions,
  repoFullName,
  issuePrData,
  enableSkillMentions,
  skillItems,
  skillState,
  onSkillsActivate,
  allowedSkillDirs,
  enableCommandMentions,
  availableCommands,
  enableSessionMentions,
  sessionItems,
  sessionProjectKey,
  commandsEnabled,
  enableAgentRoleMentions,
  agentRoleItems,
  surface,
}: {
  fileData: MentionFileDataState;
  fileSourceKind: MentionFileSourceKind;
  enableFileMentions: boolean;
  onLazyDirectoryOpen?: (directoryId: string) => void;
  enableIssueMentions: boolean;
  repoFullName?: string;
  issuePrData: ReturnType<typeof useKnownIssuePrItems>['issuePrData'];
  enableSkillMentions: boolean;
  skillItems: SkillMentionItem[];
  skillState: { status: string; error?: string };
  /** Starts the skills scan; the composer keeps it off until something asks. */
  onSkillsActivate: () => void;
  allowedSkillDirs: ReadonlySet<string> | null;
  enableCommandMentions: boolean;
  availableCommands?: AcpCommandSummary[];
  enableSessionMentions: boolean;
  sessionItems: SessionMentionItem[];
  sessionProjectKey: SessionMentionProjectKey;
  commandsEnabled: boolean;
  enableAgentRoleMentions: boolean;
  agentRoleItems: readonly AgentRoleMentionItem[];
  surface: MentionSurface;
}) {
  const context = useMentionContext('TwoLevelMentionMenu');
  const { t } = useTranslation();
  const active = context.open;
  const [sessionProjectScope, setSessionProjectScope] =
    React.useState<SessionMentionProjectScope>('current');

  React.useEffect(() => {
    if (!active) setSessionProjectScope('current');
  }, [active]);

  const toggleSessionProjectScope = React.useCallback(() => {
    setSessionProjectScope((scope) => (scope === 'current' ? 'all' : 'current'));
  }, []);
  const sessionMenuOpen =
    active &&
    context.trigger === '@' &&
    parseMentionNamespaceSearch(context.filterStore.search)?.namespace === 'session';
  useCommand(
    {
      id: 'mention.toggleSessionProjectScope',
      titleKey: 'commands.mention.toggleSessionProjectScope',
      title: 'Toggle Session Mention Project Scope',
      category: 'Editor',
      keybindings: getCommandKeybindings('mention.toggleSessionProjectScope'),
      allowInTextInput: true,
      when: () => sessionMenuOpen,
      run: toggleSessionProjectScope,
    },
    enableSessionMentions && active && commandsEnabled
  );

  const fileIndex = React.useMemo(
    () =>
      enableFileMentions ? buildMentionFileIndex(fileData.entry, buildLazyDirectoryToken) : null,
    [enableFileMentions, fileData.entry]
  );
  const issuePrSuggestions = React.useMemo(
    () =>
      enableIssueMentions && issuePrData.entry ? buildItemSuggestions(issuePrData.entry.items) : [],
    [enableIssueMentions, issuePrData.entry]
  );
  const fileSource = React.useMemo<MentionCategorySources['file']>(
    () => ({
      enabled: enableFileMentions,
      status:
        fileData.status === 'error'
          ? 'error'
          : fileData.status === 'loading' && !fileData.entry
            ? 'loading'
            : 'ready',
      message:
        fileData.status === 'error'
          ? (fileData.error ?? t('mention.file.loadError', 'Failed to load files.'))
          : undefined,
      notice: fileData.entry?.truncated
        ? fileSourceKind === 'github'
          ? t(
              'mention.file.truncatedGithub',
              'Repo is very large; GitHub returned a truncated file list.'
            )
          : t(
              'mention.file.truncatedLocal',
              'Project is very large; local file list was truncated.'
            )
        : undefined,
      index: fileIndex,
    }),
    [enableFileMentions, fileData, fileIndex, fileSourceKind, t]
  );

  // `refresh` is async, but `onActivate` is fire-and-forget (`() => void`).
  // Wrap once so the promise is explicitly discarded while keeping a stable
  // identity — the source memo lists it as a dependency.
  const refreshIssuePr = issuePrData.refresh;
  const activateIssuePr = React.useCallback(() => {
    void refreshIssuePr();
  }, [refreshIssuePr]);

  const issuePrSource = React.useMemo<MentionCategorySources['issuePr']>(
    () => ({
      enabled: enableIssueMentions,
      status:
        issuePrData.status === 'error'
          ? 'error'
          : isLazySourceLoading(issuePrData.status, Boolean(issuePrData.entry))
            ? 'loading'
            : 'ready',
      message: !repoFullName
        ? t('mention.issuePr.selectRepo', 'Select a repo to mention issues/PRs.')
        : issuePrData.status === 'error'
          ? (issuePrData.error ?? t('mention.issuePr.loadError', 'Failed to load issues and PRs.'))
          : undefined,
      onActivate: activateIssuePr,
      suggestions: issuePrSuggestions,
    }),
    [activateIssuePr, enableIssueMentions, issuePrData, issuePrSuggestions, repoFullName, t]
  );

  const skillSource = React.useMemo<MentionCategorySources['skill']>(
    () => ({
      enabled: enableSkillMentions,
      status:
        skillState.status === 'error' && skillItems.length === 0
          ? 'error'
          : isLazySourceLoading(skillState.status, skillItems.length > 0)
            ? 'loading'
            : 'ready',
      message:
        skillState.status === 'error' && skillItems.length === 0
          ? (skillState.error ??
            t('workspace.projects.skills.mention.error', 'Failed to load skills.'))
          : undefined,
      onActivate: onSkillsActivate,
      items: skillItems,
      allowedDirs: allowedSkillDirs,
    }),
    [allowedSkillDirs, enableSkillMentions, onSkillsActivate, skillItems, skillState, t]
  );

  const visibleSessionItems = React.useMemo(
    () => filterSessionMentionItemsByProject(sessionItems, sessionProjectKey, sessionProjectScope),
    [sessionItems, sessionProjectKey, sessionProjectScope]
  );
  const currentSessionScopeLabel =
    sessionProjectKey === 'chat'
      ? t('mention.session.scope.none', 'No project')
      : t('mention.session.scope.current', 'Current project');
  const sessionSource = React.useMemo<MentionCategorySources['session']>(
    () => ({
      enabled: enableSessionMentions,
      items: visibleSessionItems,
      header: {
        ariaLabel: t('mention.session.scope.label', 'Session project scope'),
        options: [
          {
            label: currentSessionScopeLabel,
            selected: sessionProjectScope === 'current',
            onSelect: () => setSessionProjectScope('current'),
          },
          {
            label: t('mention.session.scope.all', 'All projects'),
            selected: sessionProjectScope === 'all',
            onSelect: () => setSessionProjectScope('all'),
          },
        ],
      },
      emptyState:
        sessionProjectScope === 'current'
          ? {
              message:
                sessionProjectKey === 'chat'
                  ? t(
                      'mention.session.empty.none',
                      'There are no other sessions without a project.'
                    )
                  : t(
                      'mention.session.empty.current',
                      'There are no other sessions in the current project.'
                    ),
              action: {
                label: t('mention.session.scope.viewAll', 'View all projects'),
                ariaLabel: t(
                  'mention.session.scope.showAllAria',
                  'Show sessions from all projects'
                ),
                onAction: toggleSessionProjectScope,
              },
            }
          : undefined,
    }),
    [
      currentSessionScopeLabel,
      enableSessionMentions,
      sessionProjectKey,
      sessionProjectScope,
      t,
      toggleSessionProjectScope,
      visibleSessionItems,
    ]
  );

  const agentRoleSource = React.useMemo<MentionCategorySources['agentRole']>(
    () => ({ enabled: enableAgentRoleMentions, items: agentRoleItems }),
    [agentRoleItems, enableAgentRoleMentions]
  );

  const commandSource = React.useMemo<MentionCategorySources['command']>(
    () => ({ enabled: enableCommandMentions, commands: availableCommands ?? [] }),
    [availableCommands, enableCommandMentions]
  );

  const categories = useMentionCategories(
    React.useMemo(
      () => ({
        file: fileSource,
        issuePr: issuePrSource,
        skill: skillSource,
        session: sessionSource,
        agentRole: agentRoleSource,
        command: commandSource,
      }),
      [agentRoleSource, commandSource, fileSource, issuePrSource, sessionSource, skillSource]
    )
  );

  // Ask the provider to list a directory the user has drilled into but that was
  // never expanded, so the second level fills in instead of showing nothing.
  const requestedLazyDirectoriesRef = React.useRef<Set<string>>(new Set());
  const lazyDirectoryIdByToken = React.useMemo(() => {
    const ids = new Map<string, string>();
    for (const entry of fileData.entry?.lazyDirectories ?? []) {
      const token = buildLazyDirectoryToken(entry.path);
      if (token) ids.set(token, entry.directoryId);
    }
    return ids;
  }, [fileData.entry]);
  const search = context.filterStore.search;
  React.useEffect(() => {
    if (!active || !onLazyDirectoryOpen) return;
    const directoryId = lazyDirectoryIdByToken.get(search.trim());
    if (!directoryId || requestedLazyDirectoriesRef.current.has(directoryId)) return;
    requestedLazyDirectoriesRef.current.add(directoryId);
    onLazyDirectoryOpen(directoryId);
  }, [active, lazyDirectoryIdByToken, onLazyDirectoryOpen, search]);

  return <MentionTwoLevelMenu categories={categories} surface={surface} />;
}

// ============================================================================
// Hydrators
// ============================================================================

function FileMentionHydrator({
  text,
  getKnownPaths,
  enabled,
}: {
  text: string;
  /** Lazy: building the token set walks the whole file index, and hydration
   *  bails out on an empty/edited draft before it ever needs one. */
  getKnownPaths: () => Set<string>;
  enabled: boolean;
}) {
  const hydrate = React.useCallback(
    (value: string) => {
      const knownPaths = getKnownPaths();
      return knownPaths.size === 0 ? null : hydrateFileMentionsFromText(value, knownPaths);
    },
    [getKnownPaths]
  );
  useMentionHydration('FileMentionHydrator', { text, enabled, hydrate });

  return null;
}

/**
 * Restores the ranges stored with the draft.
 *
 * Runs through the same hydrate-the-initial-text-once contract as the token
 * scanners, which is the point: it inherits their guards — only against the
 * text the offsets were measured for, never while the menu is mid-commit — and
 * it composes with them, so a draft written before ranges were persisted still
 * falls back to recognising its own tokens.
 *
 * Unlike them it needs nothing loaded, so it is the one that works on a cold
 * start.
 */
function PersistedMentionHydrator({
  ranges,
  text,
  enabled,
}: {
  ranges: readonly PersistedMentionRange[];
  text: string;
  enabled: boolean;
}) {
  const hydrate = React.useCallback(
    (value: string) => {
      const restored = sanitizeMentionRanges(value, ranges);
      if (restored.length === 0) return null;
      return {
        mentions: restored,
        values: Array.from(new Set(restored.map((range) => range.value))),
      };
    },
    [ranges]
  );
  useMentionHydration('PersistedMentionHydrator', { text, enabled, hydrate });

  return null;
}

function SessionMentionHydrator({
  getKnownFileTokens,
  text,
  items,
  enabled,
}: {
  /** Paths the file source knows; they win a token both sources claim. */
  getKnownFileTokens: () => ReadonlySet<string>;
  text: string;
  items: readonly SessionMentionItem[];
  enabled: boolean;
}) {
  /**
   * Memoized because the hydration effect is not one-shot in practice: it stays
   * armed until it actually produces a range, and a draft whose `@` tokens are
   * all file paths never does. `items` changes on every session-list tick —
   * several a second while an agent streams — so building this inside `hydrate`
   * re-read and re-parsed `localStorage` on each of them, for a composer nobody
   * is typing in.
   */
  const slugToId = React.useMemo(() => resolveSessionMentionIds(items), [items]);
  const hydrate = React.useCallback(
    (value: string) =>
      // There is no `@session:` anchor to gate on any more — a session mention
      // is now a plain `@<slug>`, told apart from a path only by the slug being
      // one we know — so scan only once the draft carries an `@` at all.
      value.includes('@')
        ? hydrateSessionMentionsFromText(
            value,
            slugToId,
            // A token that is also a real path belongs to the file hydrator.
            getKnownFileTokens()
          )
        : null,
    [getKnownFileTokens, slugToId]
  );
  useMentionHydration('SessionMentionHydrator', { text, enabled, hydrate });

  return null;
}

function AgentRoleMentionHydrator({
  getKnownFileTokens,
  text,
  items,
  enabled,
}: {
  /** Paths the file source knows; they win a token both sources claim. */
  getKnownFileTokens: () => ReadonlySet<string>;
  text: string;
  items: readonly AgentRoleMentionItem[];
  enabled: boolean;
}) {
  const hydrate = React.useCallback(
    (value: string) =>
      value.includes('@')
        ? hydrateAgentRoleMentionsFromText(value, items, getKnownFileTokens())
        : null,
    [getKnownFileTokens, items]
  );
  useMentionHydration('AgentRoleMentionHydrator', { text, enabled, hydrate });

  return null;
}

// ============================================================================
// Imperative insertion
// ============================================================================

/**
 * What a surface outside the composer may write into it.
 *
 * Today's one caller is the drag-and-drop route: a sidebar session dropped on a
 * chat surface. It takes an id, not a slug, because `useSessionMentionItems` is
 * the single owner of the mentionable-session list and this component already
 * holds it — a drop target that resolved its own slug would be a second owner
 * re-slugging every visible session on every session-list tick.
 */
export type CombinedMentionTextareaHandle = {
  /**
   * Append a session mention. Returns false when nothing was written: an
   * unknown/archived/own session, or one the draft already mentions.
   */
  insertSessionMention: (sessionId: string) => boolean;
};

/**
 * Bridges the mention context out to `mentionActionsRef`.
 *
 * A child of `<Mention>` for the same reason the hydrators are: the context is
 * only readable from inside it.
 */
function MentionActionsBridge({
  actionsRef,
  items,
}: {
  actionsRef: React.Ref<CombinedMentionTextareaHandle>;
  items: readonly SessionMentionItem[];
}) {
  const context = useMentionContext('MentionActionsBridge');
  const { mentions, onMentionInsert } = context;
  React.useImperativeHandle(
    actionsRef,
    () => ({
      insertSessionMention: (sessionId: string) => {
        // Session mentions being disabled IS an empty list, so the lookup is
        // also the enablement check — there is nothing to mention.
        const item = items.find((candidate) => candidate.sessionId === sessionId);
        if (!item) return false;
        const insertion = buildSessionMentionInsertion(mentions, item);
        if (!insertion) return false;
        onMentionInsert(insertion);
        return true;
      },
    }),
    [items, mentions, onMentionInsert]
  );

  return null;
}

// ============================================================================
// Main Component
// ============================================================================

export interface CombinedMentionTextareaProps extends Omit<
  TextareaProps,
  'value' | 'defaultValue' | 'onChange'
> {
  mentionSource?: MentionProjectSource;
  availableCommands?: AcpCommandSummary[];
  /** The selected ACP provider. When set, the `$` skill menu only offers
     skills from the directories that provider is known to use; omit to offer
     every discovered skill. ACP does not define a universal project skill dir. */
  skillAgent?: SkillMentionAgent;
  /** Entry point for mention analytics (spec §8e). Defaults to 'unknown'. */
  mentionSurface?: MentionSurface;
  /** False for a mounted but hidden composer that must not own app commands. */
  commandsEnabled?: boolean;
  /** Dropped from the `@session:` category — a session never references itself. */
  currentSessionId?: string | null;
  value: string;
  onValueChange: (value: string) => void;
  containerClassName?: string;
  mentionValues?: string[];
  onMentionValuesChange?: (values: string[]) => void;
  label?: string;
  resetOnEmpty?: boolean;
  externalMentions?: MentionRange[];
  onExternalMentionsChange?: (mentions: MentionRange[]) => void;
  onMentionClick?: (mention: MentionRange) => void;
  /** Renders matching ranges as icon chips instead of plain highlights. */
  getMentionChip?: MentionChipResolver;
  /**
   * Ranges stored with the draft, restored on mount. Without these a returning
   * draft has to have its mentions recognised again from the text, which only
   * works once each source has loaded.
   */
  persistedMentions?: readonly PersistedMentionRange[];
  /**
   * Identity of the draft `value` belongs to — the session id, for a composer
   * that switches sessions in place.
   *
   * Without it a swap is indistinguishable from a very large edit: the ranges
   * of the draft that left stay committed and land on the incoming text at
   * their old offsets, and hydration — which arms once per mount — has already
   * fired, so the incoming draft's own mentions never appear. Changing this
   * drops the committed ranges and re-arms every hydrator.
   */
  draftKey?: string;
  /**
   * Every committed range, not just the external ones.
   *
   * `onExternalMentionsChange` only reports `pasted_text` because that is the
   * only kind the composer does not own. The before-send rewrite needs all of
   * them: a `@path` or `#123` survives into the sent text unchanged, so the
   * only record that the region was ever a mention is the range itself.
   */
  onMentionRangesChange?: (ranges: MentionRange[]) => void;
  /**
   * Lets a surface outside the composer write a mention into it — the drop
   * target of a dragged sidebar session, today.
   *
   * Null while the composer has no mention sources at all and renders a plain
   * textarea; a caller must treat a false return as "nothing was inserted".
   */
  mentionActionsRef?: React.Ref<CombinedMentionTextareaHandle>;
}

export const CombinedMentionTextarea = React.forwardRef<
  HTMLTextAreaElement,
  CombinedMentionTextareaProps
>(
  (
    {
      mentionSource,
      availableCommands,
      skillAgent,
      mentionSurface = 'unknown',
      commandsEnabled = true,
      currentSessionId,
      value,
      onValueChange,
      containerClassName,
      mentionValues: mentionValuesProp,
      onMentionValuesChange,
      label = 'Message',
      resetOnEmpty = true,
      externalMentions = [],
      onExternalMentionsChange,
      onMentionClick,
      getMentionChip,
      onMentionRangesChange,
      persistedMentions,
      draftKey,
      mentionActionsRef,
      className,
      ...props
    },
    ref
  ) => {
    const githubRepoFullName =
      mentionSource?.kind === 'github'
        ? mentionSource.repoFullName
        : mentionSource?.kind === 'local'
          ? mentionSource.githubRepoFullName
          : mentionSource?.kind === 'provider'
            ? mentionSource.githubRepoFullName
            : undefined;
    const githubRepoIsPublic =
      mentionSource?.kind === 'github' || mentionSource?.kind === 'provider'
        ? mentionSource.isPublic
        : undefined;
    // Resolve the analytics source_kind: worktree (live session FS) wins over the
    // project/github source, mirroring useMentionProjectFiles' source resolution.
    const usesWorktreeSource =
      mentionSource?.kind === 'provider' ||
      Boolean(mentionSource?.localWorktree?.sessionId && mentionSource?.localWorktree?.repoKey);
    const fileSourceKind: MentionFileSourceKind = usesWorktreeSource
      ? 'worktree'
      : mentionSource?.kind === 'local'
        ? 'local'
        : 'github';
    const enableFileMentions =
      mentionSource?.kind === 'provider'
        ? Boolean(mentionSource.provider || mentionSource.providerPending)
        : mentionSource?.kind === 'local'
          ? Boolean(mentionSource.localProjectId)
          : Boolean(githubRepoFullName);
    const enableIssueMentions = Boolean(githubRepoFullName);
    // The machine the chat runs on (selected agent's machine). Lets the `$` menu
    // list that machine's global skills even when the chat has no local project
    // (GitHub / plain-agent chats) — see useMentionProjectSkills.
    const skillGlobalMachineId = skillAgent?.machineId;
    const hasProjectSkillSource =
      mentionSource?.kind === 'local'
        ? Boolean(
            mentionSource.localProjectId && mentionSource.workspaceId && mentionSource.machineId
          )
        : mentionSource?.kind === 'github'
          ? Boolean(mentionSource.repoFullName)
          : mentionSource?.kind === 'provider'
            ? Boolean(mentionSource.githubRepoFullName)
            : false;
    // Enable `$` when there are project skills OR a known machine whose global
    // skills we can list (so GitHub / plain-agent chats still offer skills).
    const enableSkillMentions = hasProjectSkillSource || Boolean(skillGlobalMachineId);
    // Only scan/fetch skills once they are actually asked for, so the composer
    // doesn't kick a skills RPC on every mount. Two things ask: the menu, when a
    // query reaches the Skills category (`onActivate` below), and a draft that
    // already contains a `$` token, which the hydrator must highlight without
    // anyone opening a menu. Both the direct `$` trigger and the `@skill:`
    // category route activate the same lazy scan.
    const [skillsRequested, setSkillsRequested] = React.useState(false);
    const activateSkills = React.useCallback(() => setSkillsRequested(true), []);
    const skillsActive =
      enableSkillMentions && (skillsRequested || value.includes(SKILL_MENTION_TRIGGER));

    const { fileData, initializeLazyDirectory, getKnownFileTokens } =
      useMentionProjectFiles(mentionSource);
    // `initializeLazyDirectory` is async, but the menu's `onLazyDirectoryOpen`
    // is fire-and-forget (`=> void`). Wrap once so the promise is explicitly
    // discarded while keeping a stable identity — the consumer effect lists it
    // as a dependency, so an inline wrapper would re-fire on every render.
    const handleLazyDirectoryOpen = React.useCallback(
      (directoryId: string) => {
        void initializeLazyDirectory(directoryId);
      },
      [initializeLazyDirectory]
    );
    const sessionItems = useSessionMentionItems(currentSessionId);
    const sessionProjectKey = React.useMemo(
      () => getMentionSourceProjectKey(mentionSource),
      [mentionSource]
    );
    const agentRoleContext = React.useMemo(
      () =>
        buildAgentRoleMentionContext({
          mentionSource,
          currentMachineId: skillAgent?.machineId,
        }),
      [mentionSource, skillAgent?.machineId]
    );
    const agentRoleItems = useAgentRoleMentionItems(agentRoleContext);
    // A committed range carries only the Role id, so the caller's chip resolver
    // cannot reach the Role's emoji on its own. The composer already owns the
    // mentionable list, so it upgrades the glyph on the way through.
    const agentRoleEmojiById = React.useMemo(
      () =>
        new Map(
          agentRoleItems.map((item) => [item.role.id as string, getAgentRoleEmoji(item.role)])
        ),
      [agentRoleItems]
    );
    const resolveMentionChip = React.useMemo<MentionChipResolver | undefined>(() => {
      if (!getMentionChip) return undefined;
      return (mention, text) => {
        const chip = getMentionChip(mention, text);
        if (!chip || mention.kind !== 'agent_role') return chip;
        const emoji = agentRoleEmojiById.get(mention.value);
        return emoji ? applyAgentRoleEmojiChip(chip, emoji) : chip;
      };
    }, [agentRoleEmojiById, getMentionChip]);

    const { skillState, skillItems, knownSkillTokens } = useMentionProjectSkills(
      mentionSource,
      skillsActive,
      skillGlobalMachineId
    );
    // Limit the `$` menu to the selected provider's project + global skill directories.
    // Null when no provider is selected.
    const skillAgentCliType = skillAgent?.cliType;
    const skillAgentAgentType = skillAgent?.agentType;
    const allowedSkillDirs = React.useMemo(
      () =>
        getAllowedSkillMentionDirs({ cliType: skillAgentCliType, agentType: skillAgentAgentType }),
      [skillAgentAgentType, skillAgentCliType]
    );
    const { knownItems: knownIssuePrItems, issuePrData } = useKnownIssuePrItems(
      githubRepoFullName,
      githubRepoIsPublic
    );

    const [uncontrolledMentionValues, setUncontrolledMentionValues] = React.useState<string[]>([]);
    const mentionValues = mentionValuesProp ?? uncontrolledMentionValues;
    const [internalMentions, setInternalMentions] = React.useState<MentionRange[]>([]);

    const handleMentionValuesChange = React.useCallback(
      (next: string[]) => {
        if (mentionValuesProp === undefined) setUncontrolledMentionValues(next);
        onMentionValuesChange?.(next);
      },
      [mentionValuesProp, onMentionValuesChange]
    );
    const handleMentionsChange = React.useCallback(
      (nextMentions: MentionRange[]) => {
        onMentionRangesChange?.(nextMentions);
        const nextInternalMentions = nextMentions.filter(
          (mention) => mention.kind !== 'pasted_text'
        );
        const nextExternalMentions = nextMentions.filter(
          (mention) => mention.kind === 'pasted_text'
        );

        setInternalMentions(nextInternalMentions);
        onExternalMentionsChange?.(nextExternalMentions);
      },
      [onExternalMentionsChange, onMentionRangesChange]
    );
    const mergedMentions = React.useMemo(() => {
      const seen = new Set<string>();
      return [...internalMentions, ...externalMentions]
        .sort((a, b) => a.start - b.start)
        .filter((mention) => {
          const key = `${mention.start}:${mention.end}:${mention.value}:${mention.kind ?? 'mention'}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }, [externalMentions, internalMentions]);

    const prevValueRef = React.useRef(value);
    const [hydrationKey, setHydrationKey] = React.useState(0);
    const [menuOpen, setMenuOpen] = React.useState(false);

    // A draft swap, applied during render so the outgoing draft's ranges are
    // never painted over the incoming text — not even for one frame. Remounting
    // the tree is what re-arms the hydrators, which otherwise fire once per
    // mount and would leave the incoming draft's mentions undecorated forever.
    const [renderedDraftKey, setRenderedDraftKey] = React.useState(draftKey);
    if (renderedDraftKey !== draftKey) {
      setRenderedDraftKey(draftKey);
      setInternalMentions([]);
      setMenuOpen(false);
      // The swap is not an edit, so it must not read as one: an incoming empty
      // draft would otherwise trip the cleared-input reset below and report the
      // *new* draft's ranges as emptied.
      prevValueRef.current = value;
    }

    // Clearing content resets data and re-arms hydration, not the input DOM.
    // Replacing the textarea here loses browser focus and breaks submission's
    // disabled → enabled handoff. Only a different draft replaces the tree.
    React.useEffect(() => {
      const prevValue = prevValueRef.current;
      prevValueRef.current = value;
      if (!resetOnEmpty) return;
      if (prevValue !== '' && value === '') {
        setInternalMentions([]);
        handleMentionValuesChange([]);
        onExternalMentionsChange?.([]);
        onMentionRangesChange?.([]);
        setMenuOpen(false);
        setHydrationKey((k) => k + 1);
      }
    }, [
      handleMentionValuesChange,
      onExternalMentionsChange,
      onMentionRangesChange,
      resetOnEmpty,
      value,
    ]);

    const enableCommandMentions = Boolean(availableCommands && availableCommands.length > 0);
    const hasExternalMentionSupport =
      externalMentions.length > 0 || Boolean(onExternalMentionsChange) || Boolean(onMentionClick);
    // One list of what `@` can reach, so registering the trigger and mounting
    // the mention tree can never disagree about a type. They drifted once
    // already: a composer with only issues rendered a plain textarea.
    const enableSessionMentions = sessionItems.length > 0;
    // Having any mentionable Role IS the enablement rule: the list is already
    // filtered by visibility, executability, and work context, so an empty one
    // means there is nothing this composer could offer.
    const enableAgentRoleMentions = agentRoleItems.length > 0;
    const enableAtMentions =
      enableFileMentions ||
      enableIssueMentions ||
      enableSkillMentions ||
      enableSessionMentions ||
      enableAgentRoleMentions;
    const enableMentions = enableAtMentions || enableCommandMentions || hasExternalMentionSupport;

    // `/` trigger is only active when the entire input is a slash command (e.g. "" or "/review")
    const isSlashOnly = !value || /^\/\S*$/.test(value);
    const triggers = React.useMemo(() => {
      const t: string[] = [];
      // Every mention type is reachable through `@`; skills also retain their
      // direct `$` entry point, and slash commands retain `/` because they must
      // own the whole prompt.
      if (enableAtMentions) t.push('@');
      if (enableSkillMentions) t.push(SKILL_MENTION_TRIGGER);
      if (enableCommandMentions && isSlashOnly) t.push('/');
      return t;
    }, [enableAtMentions, enableCommandMentions, enableSkillMentions, isSlashOnly]);

    if (!enableMentions) {
      const textarea = (
        <Textarea
          ref={ref}
          // Marks the message composer so the ⇧Tab "cycle mode" command can scope
          // itself to the composer and not hijack reverse-Tab elsewhere.
          data-lody-composer-input=""
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          className={cn('resize-none', className)}
          aria-label={props['aria-label'] ?? label}
          {...props}
        />
      );

      return containerClassName ? <div className={containerClassName}>{textarea}</div> : textarea;
    }

    return (
      <Mention
        key={draftKey}
        open={value !== '' && menuOpen}
        onOpenChange={setMenuOpen}
        triggers={triggers}
        trigger={triggers[0] ?? '@'}
        inputValue={value}
        onInputValueChange={onValueChange}
        mentions={mergedMentions}
        onMentionsChange={handleMentionsChange}
        onMentionClick={onMentionClick}
        getMentionChip={resolveMentionChip}
        value={mentionValues}
        onValueChange={handleMentionValuesChange}
        onFilter={(options) => options}
        autoCloseOnEmpty={false}
        loop
        className="w-full"
      >
        <React.Fragment key={hydrationKey}>
          <FileMentionHydrator
            text={value}
            getKnownPaths={getKnownFileTokens}
            enabled={enableFileMentions}
          />
          {persistedMentions && persistedMentions.length > 0 ? (
            <PersistedMentionHydrator text={value} ranges={persistedMentions} enabled />
          ) : null}
          <SessionMentionHydrator
            getKnownFileTokens={getKnownFileTokens}
            text={value}
            items={sessionItems}
            enabled={enableSessionMentions}
          />
          <AgentRoleMentionHydrator
            getKnownFileTokens={getKnownFileTokens}
            text={value}
            items={agentRoleItems}
            enabled={enableAgentRoleMentions}
          />
          {mentionActionsRef ? (
            <MentionActionsBridge actionsRef={mentionActionsRef} items={sessionItems} />
          ) : null}
          {enableSkillMentions ? (
            <SkillMentionHydrator
              text={value}
              knownTokens={knownSkillTokens}
              enabled={skillsActive}
            />
          ) : null}
          {enableIssueMentions ? (
            <>
              <IssuePrMentionHydrator
                text={value}
                knownItems={knownIssuePrItems}
                enabled={enableIssueMentions}
              />
              <IssuePrMentionTitleHint
                repoFullName={githubRepoFullName}
                knownItems={knownIssuePrItems}
                enabled={enableIssueMentions}
              />
            </>
          ) : null}
        </React.Fragment>
        <MentionLabel className="sr-only">{label}</MentionLabel>
        <MentionInput
          ref={ref}
          // See the data attribute note above — scopes the ⇧Tab mode cycle.
          data-lody-composer-input=""
          value={value}
          containerClassName={containerClassName}
          className={cn('resize-none', className)}
          {...props}
        />
        <TwoLevelMentionMenu
          fileData={fileData}
          fileSourceKind={fileSourceKind}
          enableFileMentions={enableFileMentions}
          onLazyDirectoryOpen={handleLazyDirectoryOpen}
          enableIssueMentions={enableIssueMentions}
          repoFullName={githubRepoFullName}
          issuePrData={issuePrData}
          enableSkillMentions={enableSkillMentions}
          skillItems={skillItems}
          skillState={skillState}
          onSkillsActivate={activateSkills}
          allowedSkillDirs={allowedSkillDirs}
          enableCommandMentions={enableCommandMentions}
          availableCommands={availableCommands}
          enableSessionMentions={enableSessionMentions}
          sessionItems={sessionItems}
          sessionProjectKey={sessionProjectKey}
          commandsEnabled={commandsEnabled}
          enableAgentRoleMentions={enableAgentRoleMentions}
          agentRoleItems={agentRoleItems}
          surface={mentionSurface}
        />
      </Mention>
    );
  }
);

CombinedMentionTextarea.displayName = 'CombinedMentionTextarea';
