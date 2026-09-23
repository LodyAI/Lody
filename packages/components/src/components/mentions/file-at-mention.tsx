import { useMentionFileSearch } from './file-search/use-file-search';
import * as React from 'react';
import { forEachAtTokenSpan, type HydratedMentions } from '@/components/mentions/mention-hydration';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';

import { currentWorkspaceIdAtom } from '@/atoms';
import {
  captureMentionFileFetchError,
  getRepoMentionAnalyticsId,
  normalizeGithubFetchErrorCode,
} from '@/components/mentions/mention-analytics';
import { buildPathSuggestions } from './file-search/engine';
export * from './file-search/engine';
import {
  fetchRepoFilePaths,
  getRepoFilePathsCacheKey,
  isRepoFilePathsStale,
  readCachedRepoFilePaths,
  type RepoFilePathsCacheEntry,
} from '@/lib/repo-file-paths-cache';
import { cn } from '@/lib/utils';
import { FileIcon, FolderIcon } from '@/components/icons/file-icons';
import {
  Mention,
  MentionContent,
  MentionInput,
  MentionItem,
  MentionLabel,
  useMentionContext,
} from '@/ui/mention';
import type { TextareaProps } from '@/ui/textarea';

export type { RepoFilePathsResult } from '@/lib/repo-file-paths-cache';

export function hydrateFileMentionsFromText(text: string, knownPaths: Set<string>) {
  const mentions: HydratedMentions['mentions'] = [];
  const values = new Set<string>();

  forEachAtTokenSpan(text, ({ token, start, end }) => {
    if (!token) return false;
    // Match the candidate directly, or with a trailing slash for directories
    // whose display text has the slash stripped.
    const matchedToken = knownPaths.has(token)
      ? token
      : knownPaths.has(`${token}/`)
        ? `${token}/`
        : null;
    if (!matchedToken) return false;
    mentions.push({
      value: matchedToken,
      start,
      end,
      // The known-path set marks a directory with a trailing slash; the
      // committed text has it stripped, which is why the lookup above tries
      // both. The chip needs the distinction back to pick folder vs file glyph.
      kind: matchedToken.endsWith('/') ? 'dir' : 'file',
    });
    values.add(matchedToken);
    return true;
  });

  return { mentions, values: Array.from(values) };
}

export function useRepoFilePaths(repoFullName?: string) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const postHog = usePostHog();

  const [data, setData] = React.useState<{
    entry: RepoFilePathsCacheEntry | null;
    status: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
    error?: string;
  }>({ entry: null, status: 'idle' });

  React.useEffect(() => {
    if (!workspaceId || !repoFullName) {
      setData({ entry: null, status: 'idle' });
      return undefined;
    }

    const workspaceIdValue = workspaceId;
    const repoFullNameValue = repoFullName;

    let cancelled = false;
    const now = Date.now();
    const fetchStartedAt = Date.now();
    const key = getRepoFilePathsCacheKey(workspaceIdValue, repoFullNameValue);

    async function run() {
      const cached = await readCachedRepoFilePaths(key);
      if (cancelled) return;
      if (cached) {
        setData({
          entry: cached,
          status: isRepoFilePathsStale(cached, now) ? 'refreshing' : 'ready',
        });
        if (!isRepoFilePathsStale(cached, Date.now())) return;
      } else {
        setData((prev) => ({ ...prev, status: 'loading' }));
      }

      try {
        const entry = await fetchRepoFilePaths(workspaceIdValue, repoFullNameValue);
        if (cancelled) return;
        setData({ entry, status: 'ready' });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setData((prev) => ({
          entry: prev.entry,
          status: 'error',
          error: message,
        }));
        // Repo visibility is unknown in this hook, so hash the repo id (treat as
        // private) — never send the raw repo name (spec §2.3).
        captureMentionFileFetchError(
          postHog,
          { workspaceId: workspaceIdValue },
          {
            errorCode: normalizeGithubFetchErrorCode(err),
            repo: getRepoMentionAnalyticsId(repoFullNameValue, false),
            durationMs: Date.now() - fetchStartedAt,
          }
        );
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [postHog, repoFullName, workspaceId]);

  return data;
}

/**
 * Hook that fetches repository file paths and returns a Set of known file tokens
 * for efficient lookup during mention hydration.
 */
export function useKnownFileTokens(repoFullName?: string) {
  const fileData = useRepoFilePaths(repoFullName);

  const knownTokens = React.useMemo(() => {
    const filePaths = fileData.entry?.paths ?? [];
    if (!filePaths.length) return new Set<string>();
    return buildPathSuggestions(filePaths).allTokens;
  }, [fileData.entry]);

  return { knownTokens, status: fileData.status, error: fileData.error };
}

function FileAtMentionLoadingSkeleton() {
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

function FileAtMentionMenu({
  repoFullName,
  entry,
  status,
  error,
}: {
  repoFullName?: string;
  entry: RepoFilePathsCacheEntry | null;
  status: 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';
  error?: string;
}) {
  const context = useMentionContext('FileAtMentionMenu');

  const term = context.filterStore.search;
  const search = useMentionFileSearch(entry, context.open ? term : null);
  const indexed = search.items;

  React.useEffect(() => {
    if (!context.open) return;
    if (context.highlightedItem) return;
    if (!indexed.length) return;
    requestAnimationFrame(() => {
      const first = context.getEnabledItems()[0] ?? null;
      if (first) context.onHighlightedItemChange(first);
    });
  }, [context, indexed]);

  return (
    <MentionContent className="w-max max-w-[min(var(--mention-input-width),calc(100vw-2rem))]">
      {!repoFullName ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          Select a repo to mention files.
        </div>
      ) : (status === 'loading' && !entry) || search.status === 'loading' ? (
        <FileAtMentionLoadingSkeleton />
      ) : status === 'error' || search.status === 'error' ? (
        <div className="px-2 py-1.5 text-sm text-destructive">
          {error ?? 'Failed to load files.'}
        </div>
      ) : entry && entry.truncated ? (
        <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
          Repo is very large; GitHub returned a truncated file list.
        </div>
      ) : null}

      {indexed.length > 0 ? (
        <div className="scrollbar-pro max-h-[260px] overflow-auto overflow-x-auto">
          {indexed.map((item) => {
            const token = item.token;
            return (
              <MentionItem key={token} value={token} label={token}>
                {item.kind === 'dir' ? (
                  <FolderIcon folderPath={item.path} className="h-4 w-4 shrink-0 opacity-80" />
                ) : (
                  <FileIcon filePath={item.path} className="h-4 w-4 shrink-0 opacity-80" />
                )}
                <div className="min-w-0 whitespace-nowrap font-mono text-sm leading-5">{token}</div>
              </MentionItem>
            );
          })}
        </div>
      ) : repoFullName && status !== 'loading' ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No results</div>
      ) : null}
    </MentionContent>
  );
}

export interface FileAtMentionTextareaProps extends Omit<
  TextareaProps,
  'value' | 'defaultValue' | 'onChange'
> {
  repoFullName?: string;
  value: string;
  onValueChange: (value: string) => void;
  containerClassName?: string;
  mentionValues?: string[];
  onMentionValuesChange?: (values: string[]) => void;
  label?: string;
  resetOnEmpty?: boolean;
}

export const FileAtMentionTextarea = React.forwardRef<
  HTMLTextAreaElement,
  FileAtMentionTextareaProps
>(
  (
    {
      repoFullName,
      value,
      onValueChange,
      containerClassName,
      mentionValues: mentionValuesProp,
      onMentionValuesChange,
      label = 'Message',
      resetOnEmpty = true,
      className,
      ...props
    },
    ref
  ) => {
    const data = useRepoFilePaths(repoFullName);
    const entry = data.entry;
    const status = data.status;
    const error = data.error;
    const knownTokens = React.useMemo(() => {
      const filePaths = entry?.paths ?? [];
      if (!filePaths.length) return new Set<string>();
      return buildPathSuggestions(filePaths).allTokens;
    }, [entry]);

    const [uncontrolledMentionValues, setUncontrolledMentionValues] = React.useState<string[]>([]);
    const mentionValues = mentionValuesProp ?? uncontrolledMentionValues;

    const handleMentionValuesChange = React.useCallback(
      (next: string[]) => {
        if (mentionValuesProp === undefined) setUncontrolledMentionValues(next);
        onMentionValuesChange?.(next);
      },
      [mentionValuesProp, onMentionValuesChange]
    );

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
        handleMentionValuesChange([]);
        setInstanceKey((k) => k + 1);
      }
    }, [handleMentionValuesChange, ref, resetOnEmpty, value]);

    // Re-focus the textarea after the Mention tree remounts due to instanceKey change
    React.useEffect(() => {
      if (!shouldRefocusRef.current) return;
      shouldRefocusRef.current = false;
      const textarea = ref && typeof ref === 'object' && 'current' in ref ? ref.current : null;
      textarea?.focus();
    }, [instanceKey, ref]);

    return (
      <Mention
        key={instanceKey}
        triggers={['@']}
        trigger="@"
        inputValue={value}
        onInputValueChange={onValueChange}
        value={mentionValues}
        onValueChange={handleMentionValuesChange}
        onFilter={(options) => options}
        autoCloseOnEmpty={false}
        loop
        className="w-full"
      >
        <FileAtMentionHydrator
          text={value}
          knownPaths={knownTokens}
          enabled={Boolean(repoFullName)}
        />
        <MentionLabel className="sr-only">{label}</MentionLabel>
        <MentionInput
          ref={ref}
          value={value}
          containerClassName={containerClassName}
          className={cn('resize-none', className)}
          {...props}
        />
        <FileAtMentionMenu
          repoFullName={repoFullName}
          entry={entry}
          status={status}
          error={error}
        />
      </Mention>
    );
  }
);

FileAtMentionTextarea.displayName = 'FileAtMentionTextarea';

function FileAtMentionHydrator({
  text,
  knownPaths,
  enabled,
}: {
  text: string;
  knownPaths: Set<string>;
  enabled: boolean;
}) {
  const context = useMentionContext('FileAtMentionHydrator');
  const initialTextRef = React.useRef(text);
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled) return;
    if (hydratedRef.current) return;
    const initialText = initialTextRef.current;
    if (!initialText) return;
    if (text !== initialText) return;
    if (knownPaths.size === 0) return;
    if (context.open) return;

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
  }, [context, enabled, knownPaths, text]);

  return null;
}
