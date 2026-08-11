import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  type MentionFileSourceKind,
  type MentionSurface,
} from '@/components/mentions/mention-analytics';
import {
  buildItemSuggestions,
  getIssuePrFuseOptions,
  IssuePrMentionHydrator,
  IssuePrMentionTitleHint,
  useKnownIssuePrItems,
  type ItemSuggestion as IssuePrSuggestion,
} from '@/components/mentions/issue-pr-hash-mention';
import {
  getFuseOptions,
  hydrateFileMentionsFromText,
  type PathSuggestion,
} from '@/components/mentions/file-at-mention';
import {
  hydrateSessionMentionsFromText,
  resolveSessionMentionIds,
  useSessionMentionItems,
  SESSION_MENTION_PREFIX,
  type SessionMentionItem,
} from '@/components/mentions/mention-session-source';
import { useMentionFuseCtor } from '@/components/mentions/mention-fuse';
import { useMentionHydration } from '@/components/mentions/mention-hydration';
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
import { type AcpCommandSummary } from '@lody/shared';
import { Mention, MentionInput, MentionLabel, useMentionContext } from '@/ui/mention';
import type { Mention as MentionRange } from '@/ui/mention/index';
import { Textarea, type TextareaProps } from '@/ui/textarea';

// ============================================================================
// Two-level `@` menu
// ============================================================================

/**
 * Builds the mention registry from the composer's already-fetched data and
 * renders the single `@` menu. Lives inside `<Mention>` so Fuse loading stays
 * keyed to the menu actually being open.
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
  allowedSkillDirs,
  enableCommandMentions,
  availableCommands,
  sessionItems,
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
  allowedSkillDirs: ReadonlySet<string> | null;
  enableCommandMentions: boolean;
  availableCommands?: AcpCommandSummary[];
  sessionItems: SessionMentionItem[];
  surface: MentionSurface;
}) {
  const context = useMentionContext('TwoLevelMentionMenu');
  const { t } = useTranslation();
  const active = context.open;

  const fileIndex = React.useMemo(
    () =>
      enableFileMentions ? buildMentionFileIndex(fileData.entry, buildLazyDirectoryToken) : null,
    [enableFileMentions, fileData.entry]
  );
  const fileFuseCtor = useMentionFuseCtor<PathSuggestion>(active && fileIndex !== null);
  const fileFuse = React.useMemo(() => {
    if (!fileFuseCtor || !fileIndex) return null;
    try {
      return new fileFuseCtor(fileIndex.allSuggestions, getFuseOptions());
    } catch {
      return null;
    }
  }, [fileFuseCtor, fileIndex]);

  const issuePrSuggestions = React.useMemo(
    () =>
      enableIssueMentions && issuePrData.entry ? buildItemSuggestions(issuePrData.entry.items) : [],
    [enableIssueMentions, issuePrData.entry]
  );
  const issuePrFuseCtor = useMentionFuseCtor<IssuePrSuggestion>(
    active && issuePrSuggestions.length > 0
  );
  const createIssuePrFuse = React.useCallback(
    (list: IssuePrSuggestion[]) => {
      if (!issuePrFuseCtor || list.length === 0) return null;
      try {
        return new issuePrFuseCtor(list, getIssuePrFuseOptions());
      } catch {
        return null;
      }
    },
    [issuePrFuseCtor]
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
      fuse: fileFuse,
    }),
    [enableFileMentions, fileData, fileFuse, fileIndex, fileSourceKind, t]
  );

  const issuePrSource = React.useMemo<MentionCategorySources['issuePr']>(
    () => ({
      enabled: enableIssueMentions,
      status:
        issuePrData.status === 'error'
          ? 'error'
          : issuePrData.status === 'loading' && !issuePrData.entry
            ? 'loading'
            : 'ready',
      message: !repoFullName
        ? t('mention.issuePr.selectRepo', 'Select a repo to mention issues/PRs.')
        : issuePrData.status === 'error'
          ? (issuePrData.error ?? t('mention.issuePr.loadError', 'Failed to load issues and PRs.'))
          : undefined,
      suggestions: issuePrSuggestions,
      createFuse: createIssuePrFuse,
    }),
    [createIssuePrFuse, enableIssueMentions, issuePrData, issuePrSuggestions, repoFullName, t]
  );

  const skillSource = React.useMemo<MentionCategorySources['skill']>(
    () => ({
      enabled: enableSkillMentions,
      status:
        skillState.status === 'error' && skillItems.length === 0
          ? 'error'
          : skillState.status === 'loading' && skillItems.length === 0
            ? 'loading'
            : 'ready',
      message:
        skillState.status === 'error' && skillItems.length === 0
          ? (skillState.error ??
            t('workspace.projects.skills.mention.error', 'Failed to load skills.'))
          : undefined,
      items: skillItems,
      allowedDirs: allowedSkillDirs,
    }),
    [allowedSkillDirs, enableSkillMentions, skillItems, skillState, t]
  );

  const sessionSource = React.useMemo<MentionCategorySources['session']>(
    () => ({ enabled: sessionItems.length > 0, items: sessionItems }),
    [sessionItems]
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
        command: commandSource,
      }),
      [commandSource, fileSource, issuePrSource, sessionSource, skillSource]
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

function SessionMentionHydrator({
  text,
  items,
  enabled,
}: {
  text: string;
  items: readonly SessionMentionItem[];
  enabled: boolean;
}) {
  const hydrate = React.useCallback(
    (value: string) =>
      // Reading the slug cache parses localStorage, so only pay for it once the
      // draft actually carries the anchor.
      value.includes(SESSION_MENTION_PREFIX)
        ? hydrateSessionMentionsFromText(value, resolveSessionMentionIds(items))
        : null,
    [items]
  );
  useMentionHydration('SessionMentionHydrator', { text, enabled, hydrate });

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
    // Only scan/fetch skills once the user actually engages the `$` trigger (or
    // a draft already contains one), so the composer doesn't kick a skills RPC
    // on every mount. The trigger is still registered below so typing `$` opens
    // the menu (which then shows a brief loading state on first use).
    const skillsActive = enableSkillMentions && value.includes(SKILL_MENTION_TRIGGER);

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
        const nextInternalMentions = nextMentions.filter(
          (mention) => mention.kind !== 'pasted_text'
        );
        const nextExternalMentions = nextMentions.filter(
          (mention) => mention.kind === 'pasted_text'
        );

        setInternalMentions(nextInternalMentions);
        onExternalMentionsChange?.(nextExternalMentions);
      },
      [onExternalMentionsChange]
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

    const [instanceKey, setInstanceKey] = React.useState(0);
    const prevValueRef = React.useRef(value);
    const shouldRefocusRef = React.useRef(false);
    React.useEffect(() => {
      const prevValue = prevValueRef.current;
      prevValueRef.current = value;
      if (!resetOnEmpty) return;
      if (prevValue !== '' && value === '') {
        // Track whether the textarea had focus before the reset so we can restore it
        const textarea = ref && typeof ref === 'object' && 'current' in ref ? ref.current : null;
        if (textarea && document.activeElement === textarea) {
          shouldRefocusRef.current = true;
        }
        setInternalMentions([]);
        handleMentionValuesChange([]);
        onExternalMentionsChange?.([]);
        setInstanceKey((k) => k + 1);
      }
    }, [handleMentionValuesChange, onExternalMentionsChange, ref, resetOnEmpty, value]);

    // Re-focus the textarea after the Mention tree remounts due to instanceKey change
    React.useEffect(() => {
      if (!shouldRefocusRef.current) return;
      shouldRefocusRef.current = false;
      const textarea = ref && typeof ref === 'object' && 'current' in ref ? ref.current : null;
      textarea?.focus();
    }, [instanceKey, ref]);

    const enableCommandMentions = Boolean(availableCommands && availableCommands.length > 0);
    const hasExternalMentionSupport =
      externalMentions.length > 0 || Boolean(onExternalMentionsChange) || Boolean(onMentionClick);
    const enableMentions =
      enableFileMentions ||
      enableCommandMentions ||
      enableSkillMentions ||
      hasExternalMentionSupport;

    // `/` trigger is only active when the entire input is a slash command (e.g. "" or "/review")
    const isSlashOnly = !value || /^\/\S*$/.test(value);
    const triggers = React.useMemo(() => {
      const t: string[] = [];
      // Every mention type is reached through `@`. `/` is the one exception: a
      // slash command must own the whole prompt, so it never nests under a
      // category and only fires on a slash-only composer.
      if (enableFileMentions || enableIssueMentions || enableSkillMentions) t.push('@');
      if (enableCommandMentions && isSlashOnly) t.push('/');
      return t;
    }, [
      enableFileMentions,
      enableIssueMentions,
      enableSkillMentions,
      enableCommandMentions,
      isSlashOnly,
    ]);

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
        key={instanceKey}
        triggers={triggers}
        trigger={triggers[0] ?? '@'}
        inputValue={value}
        onInputValueChange={onValueChange}
        mentions={mergedMentions}
        onMentionsChange={handleMentionsChange}
        onMentionClick={onMentionClick}
        value={mentionValues}
        onValueChange={handleMentionValuesChange}
        onFilter={(options) => options}
        autoCloseOnEmpty={false}
        className="w-full"
      >
        <FileMentionHydrator
          text={value}
          getKnownPaths={getKnownFileTokens}
          enabled={enableFileMentions}
        />
        <SessionMentionHydrator
          text={value}
          items={sessionItems}
          enabled={sessionItems.length > 0}
        />
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
          allowedSkillDirs={allowedSkillDirs}
          enableCommandMentions={enableCommandMentions}
          availableCommands={availableCommands}
          sessionItems={sessionItems}
          surface={mentionSurface}
        />
      </Mention>
    );
  }
);

CombinedMentionTextarea.displayName = 'CombinedMentionTextarea';
