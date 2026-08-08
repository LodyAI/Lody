import * as React from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { currentWorkspaceIdAtom } from '@/atoms';
import { cn } from '@/lib/utils';
import { FileIcon, FolderIcon } from '@/components/icons/file-icons';
import { CommandSlashMentionMenu } from '@/components/mentions/command-slash-mention';
import {
  captureMentionFileMenuEmpty,
  captureMentionFileMenuOpen,
  captureMentionFileSelect,
  type MentionFileSourceKind,
  type MentionSurface,
} from '@/components/mentions/mention-analytics';
import {
  IssuePrMentionHydrator,
  IssuePrMentionMenu,
  IssuePrMentionTitleHint,
  useKnownIssuePrItems,
} from '@/components/mentions/issue-pr-hash-mention';
import {
  buildPathSuggestions,
  type FuseConstructor,
  getFuseOptions,
  getSuggestions,
  hydrateFileMentionsFromText,
  type PathSuggestion,
} from '@/components/mentions/file-at-mention';
import {
  buildLazyDirectoryToken,
  type MentionFileDataState,
  type MentionProjectSource,
  useMentionProjectFiles,
} from '@/components/mentions/mention-project-file-source';
import {
  SKILL_MENTION_TRIGGER,
  SkillMentionHydrator,
  SkillMentionMenu,
  getAllowedSkillMentionDirs,
  type SkillMentionAgent,
  type SkillMentionMenuPlacement,
  useMentionProjectSkills,
} from '@/components/mentions/mention-skill-source';
import { type AcpCommandSummary } from '@lody/shared';
import {
  Mention,
  MentionContent,
  MentionInput,
  MentionItem,
  MentionLabel,
  useMentionContext,
} from '@/ui/mention';
import type { Mention as MentionRange } from '@/ui/mention/index';
import { Textarea, type TextareaProps } from '@/ui/textarea';

// ============================================================================
// UI Components
// ============================================================================

function FileMentionLoadingSkeleton() {
  const rows = ['w-[72%]', 'w-[54%]', 'w-[86%]', 'w-[63%]', 'w-[78%]', 'w-[58%]'];

  return (
    <div className="px-2 py-2">
      <div className="animate-pulse space-y-2">
        {rows.map((widthClass, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            className={cn('h-4 rounded-xs', 'bg-muted/70', widthClass)}
          />
        ))}
      </div>
    </div>
  );
}

let fileFuseCtorCache: FuseConstructor<PathSuggestion> | null = null;
let fileFuseCtorPromise: Promise<void> | null = null;
const fileFuseCtorSubscribers = new Set<() => void>();

function loadFileFuseCtor(): void {
  if (fileFuseCtorCache || fileFuseCtorPromise) return;
  fileFuseCtorPromise = import('fuse.js')
    .then((mod) => {
      const ctor = (mod as unknown as { default?: unknown }).default ?? mod;
      fileFuseCtorCache = ctor as FuseConstructor<PathSuggestion>;
      fileFuseCtorSubscribers.forEach((callback) => {
        callback();
      });
    })
    .catch(() => {
      // fuse.js isn't installed yet; fallback to substring matching.
      fileFuseCtorPromise = null;
    });
}

function subscribeFileFuseCtor(callback: () => void): () => void {
  fileFuseCtorSubscribers.add(callback);
  return () => {
    fileFuseCtorSubscribers.delete(callback);
  };
}

function getFileFuseCtorSnapshot(): FuseConstructor<PathSuggestion> | null {
  return fileFuseCtorCache;
}

function useFileFuseCtor(enabled: boolean): FuseConstructor<PathSuggestion> | null {
  const ctor = React.useSyncExternalStore(
    subscribeFileFuseCtor,
    getFileFuseCtorSnapshot,
    getFileFuseCtorSnapshot
  );
  React.useEffect(() => {
    if (enabled) loadFileFuseCtor();
  }, [enabled]);
  return enabled ? ctor : null;
}

function FileMentionMenu({
  sourceKind,
  fileData,
  onLazyDirectoryOpen,
  surface,
}: {
  sourceKind: MentionFileSourceKind;
  fileData: MentionFileDataState;
  onLazyDirectoryOpen?: (directoryId: string) => void;
  surface: MentionSurface;
}) {
  const context = useMentionContext('FileMentionMenu');
  const trigger = context.trigger;
  const postHog = usePostHog();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);

  // File mention state
  const fileTerm = trigger === '@' ? context.filterStore.search : '';
  const fileSuggestionIndex = React.useMemo(() => {
    if (!fileData.entry || trigger !== '@') return null;
    const base = buildPathSuggestions(fileData.entry.paths);
    const tokens = new Set(base.allTokens);
    const lazyDirectories =
      fileData.entry.lazyDirectories?.flatMap((entry) => {
        const token = buildLazyDirectoryToken(entry.path);
        if (!token || tokens.has(token)) return [];
        tokens.add(token);
        return [
          {
            kind: 'dir' as const,
            path: token.replace(/\/+$/u, ''),
            token,
            searchable: token.toLowerCase(),
          },
        ];
      }) ?? [];
    if (lazyDirectories.length === 0) return base;
    const dirs = [...base.dirs, ...lazyDirectories].sort((left, right) =>
      left.token.localeCompare(right.token)
    );
    return {
      dirs,
      files: base.files,
      allSuggestions: [...dirs, ...base.files],
      allTokens: tokens,
    };
  }, [fileData.entry, trigger]);
  const lazyDirectoryIdByToken = React.useMemo(() => {
    const ids = new Map<string, string>();
    for (const entry of fileData.entry?.lazyDirectories ?? []) {
      const token = buildLazyDirectoryToken(entry.path);
      if (token) ids.set(token, entry.directoryId);
    }
    return ids;
  }, [fileData.entry]);

  const fileFuseCtor = useFileFuseCtor(
    context.open && trigger === '@' && fileSuggestionIndex !== null
  );

  const fileFuse = React.useMemo(() => {
    if (!fileFuseCtor || !fileSuggestionIndex) return null;
    try {
      return new fileFuseCtor(fileSuggestionIndex.allSuggestions, getFuseOptions());
    } catch {
      return null;
    }
  }, [fileFuseCtor, fileSuggestionIndex]);

  const fileIndexed = React.useMemo(() => {
    if (!fileSuggestionIndex || trigger !== '@') return [];
    return getSuggestions(fileSuggestionIndex, fileTerm, fileFuse);
  }, [fileSuggestionIndex, fileTerm, fileFuse, trigger]);
  const requestedLazyDirectoriesRef = React.useRef<Set<string>>(new Set());
  const {
    open: mentionMenuOpen,
    highlightedItem,
    getEnabledItems,
    onHighlightedItemChange,
  } = context;
  React.useEffect(() => {
    if (!context.open || trigger !== '@' || !onLazyDirectoryOpen) return;
    const directoryId = lazyDirectoryIdByToken.get(fileTerm.trim());
    if (!directoryId || requestedLazyDirectoriesRef.current.has(directoryId)) return;
    requestedLazyDirectoriesRef.current.add(directoryId);
    onLazyDirectoryOpen(directoryId);
  }, [context.open, fileTerm, lazyDirectoryIdByToken, onLazyDirectoryOpen, trigger]);

  // Auto-highlight first item
  React.useEffect(() => {
    let frameId: number | null = null;
    if (mentionMenuOpen && !highlightedItem && trigger === '@') {
      const items = getEnabledItems();
      if (items.length) {
        frameId = requestAnimationFrame(() => {
          const first = items[0] ?? null;
          if (first) onHighlightedItemChange(first);
        });
      }
    }
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    fileIndexed,
    getEnabledItems,
    highlightedItem,
    mentionMenuOpen,
    onHighlightedItemChange,
    trigger,
  ]);

  const analyticsBase = React.useMemo(() => ({ workspaceId, surface }), [workspaceId, surface]);

  // One `menu_open` per open of the @file menu (tier B). Reset when it closes.
  const menuOpenTrackedRef = React.useRef(false);
  React.useEffect(() => {
    if (!context.open || trigger !== '@') {
      menuOpenTrackedRef.current = false;
      return;
    }
    if (menuOpenTrackedRef.current) return;
    menuOpenTrackedRef.current = true;
    captureMentionFileMenuOpen(postHog, analyticsBase, {
      sourceKind,
      status: fileData.status,
      itemsCount:
        (fileData.entry?.paths.length ?? 0) + (fileData.entry?.lazyDirectories?.length ?? 0),
    });
  }, [analyticsBase, context.open, fileData.entry, fileData.status, postHog, sourceKind, trigger]);

  // Empty-state once results settle (not while loading/erroring). Debounced and
  // emitted at most once per empty-results episode so typing does not flood
  // PostHog with one event per query.
  const emptyTrackedForOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (!context.open || trigger !== '@') {
      emptyTrackedForOpenRef.current = false;
      return undefined;
    }
    if (fileData.status === 'loading' || fileData.status === 'error') return undefined;
    if (fileIndexed.length > 0) {
      emptyTrackedForOpenRef.current = false;
      return undefined;
    }
    if (emptyTrackedForOpenRef.current) return undefined;
    const timeoutId = window.setTimeout(() => {
      emptyTrackedForOpenRef.current = true;
      captureMentionFileMenuEmpty(postHog, analyticsBase, {
        sourceKind,
        termLength: fileTerm.length,
      });
    }, 750);
    return () => window.clearTimeout(timeoutId);
  }, [
    analyticsBase,
    context.open,
    fileData.status,
    fileIndexed.length,
    fileTerm,
    postHog,
    sourceKind,
    trigger,
  ]);

  // Render based on trigger
  if (trigger === '@') {
    return (
      <MentionContent className="w-max max-w-[min(var(--mention-input-width),calc(100vw-2rem))]">
        {fileData.status === 'loading' && !fileData.entry ? (
          <FileMentionLoadingSkeleton />
        ) : fileData.status === 'error' ? (
          <div className="px-2 py-1.5 text-sm text-destructive">
            {fileData.error ?? 'Failed to load files.'}
          </div>
        ) : fileData.entry && fileData.entry.truncated ? (
          <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
            {sourceKind === 'github'
              ? 'Repo is very large; GitHub returned a truncated file list.'
              : 'Project is very large; local file list was truncated.'}
          </div>
        ) : null}

        {fileIndexed.length > 0 ? (
          <div className="scrollbar-pro max-h-[260px] overflow-auto overflow-x-auto">
            {fileIndexed.map((item, index) => {
              const token = item.token;
              const isDirectory = item.kind === 'dir';
              return (
                <MentionItem
                  key={token}
                  value={token}
                  label={token}
                  kind={isDirectory ? 'dir' : 'file'}
                  // Selecting a directory descends into it; committing one
                  // (Enter on an exact match) drops the trailing slash so the
                  // text reads `@src/components`.
                  navigateText={isDirectory ? `@${token}` : undefined}
                  insertText={isDirectory ? `@${token.replace(/\/+$/, '')}` : undefined}
                  onMentionSelect={() => {
                    captureMentionFileSelect(postHog, analyticsBase, {
                      kind: item.kind,
                      rank: index,
                      termLength: fileTerm.length,
                      sourceKind,
                    });
                  }}
                >
                  {item.kind === 'dir' ? (
                    <FolderIcon folderPath={item.path} className="h-4 w-4 shrink-0 opacity-80" />
                  ) : (
                    <FileIcon filePath={item.path} className="h-4 w-4 shrink-0 opacity-80" />
                  )}
                  <div className="min-w-0 whitespace-nowrap font-mono text-sm leading-5">
                    {token}
                  </div>
                </MentionItem>
              );
            })}
          </div>
        ) : fileData.status !== 'loading' && fileData.status !== 'error' ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No results</div>
        ) : null}
      </MentionContent>
    );
  }

  return null;
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
  const context = useMentionContext('FileMentionHydrator');
  const initialTextRef = React.useRef(text);
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled) return;
    if (hydratedRef.current) return;
    const initialText = initialTextRef.current;
    if (!initialText) return;
    if (text !== initialText) return;
    if (context.open) return;
    const knownPaths = getKnownPaths();
    if (knownPaths.size === 0) return;

    const hydrated = hydrateFileMentionsFromText(initialText, knownPaths);
    if (hydrated.mentions.length === 0) return;

    hydratedRef.current = true;
    context.onMentionsChange((prev) => {
      const merged = [...prev, ...hydrated.mentions].sort((a, b) => a.start - b.start);
      const seen = new Set<string>();
      return merged.filter((m) => {
        const key = `${m.start}:${m.end}:${m.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    context.onValueChange((prev) => {
      const next = new Set([...(prev ?? []), ...hydrated.values]);
      return Array.from(next);
    });
  }, [context, enabled, getKnownPaths, text]);

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
  /** `$` menu placement; landing uses caret/default positioning. */
  skillMentionPlacement?: SkillMentionMenuPlacement;
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
      skillMentionPlacement,
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
      if (enableFileMentions) t.push('@');
      if (enableIssueMentions) t.push('#');
      if (enableSkillMentions) t.push(SKILL_MENTION_TRIGGER);
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
        <FileMentionMenu
          sourceKind={fileSourceKind}
          fileData={fileData}
          onLazyDirectoryOpen={handleLazyDirectoryOpen}
          surface={mentionSurface}
        />
        {enableIssueMentions ? (
          <IssuePrMentionMenu
            repoFullName={githubRepoFullName}
            isPublic={githubRepoIsPublic}
            issuePrData={issuePrData}
            surface={mentionSurface}
          />
        ) : null}
        {enableCommandMentions && availableCommands ? (
          <CommandSlashMentionMenu commands={availableCommands} surface={mentionSurface} />
        ) : null}
        {enableSkillMentions ? (
          <SkillMentionMenu
            skillItems={skillItems}
            status={skillState.status}
            error={skillState.error}
            allowedDirs={allowedSkillDirs}
            placement={skillMentionPlacement}
          />
        ) : null}
      </Mention>
    );
  }
);

CombinedMentionTextarea.displayName = 'CombinedMentionTextarea';
