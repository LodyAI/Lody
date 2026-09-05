import { normalizeFileDiff, type FileDiff, type SessionId } from '@lody/shared';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  createConversationDerivation,
  type ConversationView,
  type DeriveTurnFact,
} from '@/lib/conversation-view';
import type {
  SessionFileChangedFilesResult,
  SessionFileChangeEntry,
  SessionFileProvider,
} from '@/lib/session-file-provider';
import {
  areSessionDiffSummariesEqual,
  buildSessionDiffSummary,
  buildSessionDiffSummaryFromProviderChanges,
  EMPTY_SESSION_DIFF_SUMMARY,
  type SessionDiffSummary,
} from './session-diff-summary';

type SessionDiffSummaryState = {
  ready: boolean;
  synced: boolean;
  revision: number;
  source: 'initial' | 'fallback' | 'provider';
  summary: SessionDiffSummary;
  unavailableMessage?: string;
};

const INITIAL_STATE: SessionDiffSummaryState = {
  ready: false,
  synced: false,
  revision: 0,
  source: 'initial',
  summary: EMPTY_SESSION_DIFF_SUMMARY,
};

const PROVIDER_DIFF_SUMMARY_MAX_ERROR_RETRIES = 2;
const PROVIDER_DIFF_SUMMARY_RETRY_DELAY_MS = 800;

type SessionHistoryInput = Parameters<typeof buildSessionDiffSummary>[0];
type SessionHistoryEntryInput = NonNullable<SessionHistoryInput>[number];

function getSessionHistoryEntryRole(entry: SessionHistoryEntryInput): string | undefined {
  const role = (entry as { readonly role?: unknown }).role;
  return typeof role === 'string' ? role : undefined;
}

function buildChangedFilesResultFromHistoryEntry(
  entry: SessionHistoryEntryInput
): SessionFileChangedFilesResult {
  const fileDiffs = normalizeHistoryEntryFileDiffs(entry);
  return {
    status: 'ready',
    files: fileDiffs.map((fileDiff) => ({
      path: fileDiff.filePath,
      kind: 'text',
      sourceState: 'historical-turn',
      add: fileDiff.add,
      del: fileDiff.del,
    })),
  };
}

function collectFileDiffsByTurnFromHistory(
  history: SessionHistoryInput
): Record<string, FileDiff[]> {
  const fileDiffsByTurn: Record<string, FileDiff[]> = {};
  for (const entry of history ?? []) {
    if (!entry?.id) continue;
    const fileDiffs = normalizeHistoryEntryFileDiffs(entry);
    if (fileDiffs.length > 0) {
      fileDiffsByTurn[entry.id] = fileDiffs;
    }
  }
  return fileDiffsByTurn;
}

function normalizeHistoryEntryFileDiffs(entry: SessionHistoryEntryInput): FileDiff[] {
  const rawDiffs = (entry as { readonly fileDiff?: unknown }).fileDiff;
  if (!Array.isArray(rawDiffs)) return [];
  return rawDiffs.flatMap((rawDiff) => {
    const normalized = normalizeFileDiff(rawDiff);
    return normalized === undefined ? [] : [normalized];
  });
}

/** What the fallback summary needs from a turn; derived per turn object. */
type DiffInputEntry = { id: string; role: string; fileDiff: unknown };

const deriveDiffInputEntry: DeriveTurnFact<DiffInputEntry> = (turn) => ({
  id: turn.id,
  role: turn.role,
  fileDiff: turn.fileDiff,
});

/**
 * Per-turn diff inputs for the whole conversation in order, from a fact table
 * over the view: turns the background pass has not reached yet are absent and
 * appear as the pass completes.
 */
function collectDiffInputs(
  view: ConversationView,
  facts: ReadonlyMap<string, DiffInputEntry>
): DiffInputEntry[] {
  const entries: DiffInputEntry[] = [];
  for (let i = 0; i < view.turnCount; i += 1) {
    const row = view.index(i);
    const fact = row ? facts.get(row.id) : undefined;
    if (fact) entries.push(fact);
  }
  return entries;
}

export function computeSessionDiffInputsFingerprint(history: SessionHistoryInput): string {
  return JSON.stringify(
    (history ?? []).map((entry) => [
      entry?.id ?? '',
      getSessionHistoryEntryRole(entry) ?? '',
      normalizeHistoryEntryFileDiffs(entry).map((fileDiff) => [
        fileDiff.filePath,
        fileDiff.add,
        fileDiff.del,
        fileDiff.cc === undefined
          ? null
          : [
              fileDiff.cc.v,
              fileDiff.cc.fileId,
              fileDiff.cc.baseOpId ?? '',
              fileDiff.cc.opId ?? '',
              fileDiff.cc.base ?? '',
              fileDiff.cc.deleted === true,
            ],
      ]),
    ])
  );
}

export function selectProviderDiffTurnIds(history: SessionHistoryInput): string[] {
  const turnIds: string[] = [];
  for (const entry of history ?? []) {
    if (!entry?.id) continue;
    const role = getSessionHistoryEntryRole(entry);
    if (role !== undefined && role !== 'assistant') continue;
    turnIds.push(entry.id);
  }
  return turnIds;
}

export function collectReadyProviderChangedFilesByTurn(
  changedFilesByTurnEntries: readonly (readonly [string, SessionFileChangedFilesResult])[]
): Record<string, readonly SessionFileChangeEntry[]> {
  const changedFilesByTurn: Record<string, readonly SessionFileChangeEntry[]> = {};
  for (const [turnId, changedFiles] of changedFilesByTurnEntries) {
    if (changedFiles.status === 'unavailable') {
      continue;
    }
    if (changedFiles.files.length > 0) {
      changedFilesByTurn[turnId] = changedFiles.files;
    }
  }
  return changedFilesByTurn;
}

export function buildProviderDiffSummaryFromChangedFileResults(
  allChangedFiles: SessionFileChangedFilesResult,
  changedFilesByTurnEntries: readonly (readonly [string, SessionFileChangedFilesResult])[],
  fileDiffsByTurn: Record<string, FileDiff[]> = {}
): {
  readonly summary: SessionDiffSummary;
  readonly unavailableMessage?: string;
} {
  const changedFilesByTurn = collectReadyProviderChangedFilesByTurn(changedFilesByTurnEntries);
  const summary = buildSessionDiffSummaryFromProviderChanges(
    allChangedFiles.status === 'ready' ? allChangedFiles.files : null,
    changedFilesByTurn,
    fileDiffsByTurn
  );

  if (allChangedFiles.status === 'unavailable') {
    return {
      summary,
      unavailableMessage: allChangedFiles.message ?? 'Code Collab diff summary is unavailable',
    };
  }

  return { summary };
}

export function shouldRetryProviderDiffSummaryMessage(message: string): boolean {
  return /\b(timeout|timed out|sync failed|connect request|network|fetch failed|failed to fetch|transient)\b/iu.test(
    message
  );
}

export function useSessionDiffSummary(
  sessionId: SessionId,
  options: {
    readonly fileProvider?: SessionFileProvider | null;
    readonly fileProviderPending?: boolean;
    readonly enabled?: boolean;
  } = {}
): SessionDiffSummaryState {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const enabled = options.enabled ?? true;
  const fileProvider = options.fileProvider ?? null;
  const fileProviderPending = options.fileProviderPending ?? false;
  const providerModeActive = enabled && fileProvider !== null;
  const [state, setState] = useState<SessionDiffSummaryState>(INITIAL_STATE);
  const [diffInputsVersion, setDiffInputsVersion] = useState(0);
  const historyRef = useRef<SessionHistoryInput>(undefined);
  const diffInputsFingerprintRef = useRef<string | undefined>(undefined);
  const fileProviderRef = useRef<SessionFileProvider | null>(fileProvider);
  const providerSummaryRetryAttemptsRef = useRef(0);
  const providerSummaryRetryTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    fileProviderRef.current = fileProvider;
  }, [fileProvider]);

  useEffect(() => {
    if (providerSummaryRetryTimeoutRef.current !== null) {
      window.clearTimeout(providerSummaryRetryTimeoutRef.current);
      providerSummaryRetryTimeoutRef.current = null;
    }
    providerSummaryRetryAttemptsRef.current = 0;
  }, [fileProvider, fileProviderPending, sessionId]);

  useEffect(
    () => () => {
      if (providerSummaryRetryTimeoutRef.current !== null) {
        window.clearTimeout(providerSummaryRetryTimeoutRef.current);
        providerSummaryRetryTimeoutRef.current = null;
      }
    },
    []
  );

  const shouldUpdateFallbackSummary = (): boolean => !fileProviderRef.current;

  useEffect(() => {
    if (!providerModeActive) {
      return;
    }
    setState((prev) => {
      if (
        !prev.ready &&
        prev.source === 'initial' &&
        areSessionDiffSummariesEqual(prev.summary, EMPTY_SESSION_DIFF_SUMMARY)
      ) {
        return prev;
      }
      return {
        ...prev,
        ready: false,
        source: 'initial',
        revision: prev.revision + 1,
        summary: EMPTY_SESSION_DIFF_SUMMARY,
        unavailableMessage: undefined,
      };
    });
  }, [providerModeActive, sessionId]);

  useEffect(() => {
    if (!enabled) {
      historyRef.current = undefined;
      diffInputsFingerprintRef.current = undefined;
      setState(INITIAL_STATE);
      return undefined;
    }

    const history = historyRef.current;
    if (!history) {
      return undefined;
    }

    if (!fileProvider) {
      if (!shouldUpdateFallbackSummary()) {
        return undefined;
      }
      const nextSummary = buildSessionDiffSummary(history);
      setState((prev) => {
        if (areSessionDiffSummariesEqual(prev.summary, nextSummary)) {
          if (prev.source === 'fallback') {
            return prev.unavailableMessage === undefined
              ? prev
              : { ...prev, unavailableMessage: undefined };
          }
          return { ...prev, source: 'fallback', unavailableMessage: undefined };
        }
        return {
          ...prev,
          ready: true,
          source: 'fallback',
          revision: prev.revision + 1,
          summary: nextSummary,
          unavailableMessage: undefined,
        };
      });
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      try {
        const turnIds = selectProviderDiffTurnIds(history);
        const allChangedFiles = await fileProvider.listChangedFiles();
        const changedFilesByTurnEntries: (readonly [string, SessionFileChangedFilesResult])[] = [];
        for (const entry of history) {
          if (cancelled) {
            return;
          }
          if (!entry?.id || !turnIds.includes(entry.id)) continue;
          changedFilesByTurnEntries.push([
            entry.id,
            buildChangedFilesResultFromHistoryEntry(entry),
          ] as const);
        }
        if (cancelled) {
          return;
        }
        const providerSummaryResult = buildProviderDiffSummaryFromChangedFileResults(
          allChangedFiles,
          changedFilesByTurnEntries,
          collectFileDiffsByTurnFromHistory(history)
        );
        if (providerSummaryResult.unavailableMessage !== undefined) {
          const shouldRetry =
            shouldRetryProviderDiffSummaryMessage(providerSummaryResult.unavailableMessage) &&
            providerSummaryRetryAttemptsRef.current < PROVIDER_DIFF_SUMMARY_MAX_ERROR_RETRIES &&
            typeof window !== 'undefined';
          if (shouldRetry) {
            providerSummaryRetryAttemptsRef.current += 1;
            const attempt = providerSummaryRetryAttemptsRef.current;
            if (providerSummaryRetryTimeoutRef.current !== null) {
              window.clearTimeout(providerSummaryRetryTimeoutRef.current);
            }
            providerSummaryRetryTimeoutRef.current = window.setTimeout(() => {
              providerSummaryRetryTimeoutRef.current = null;
              if (!cancelled) {
                setDiffInputsVersion((prev) => prev + 1);
              }
            }, PROVIDER_DIFF_SUMMARY_RETRY_DELAY_MS * attempt);
            return;
          }
          setState((prev) => {
            const summaryChanged = !areSessionDiffSummariesEqual(
              prev.summary,
              providerSummaryResult.summary
            );
            if (
              prev.ready &&
              prev.source === 'provider' &&
              !summaryChanged &&
              prev.unavailableMessage === providerSummaryResult.unavailableMessage
            ) {
              return prev;
            }
            return {
              ...prev,
              ready: true,
              source: 'provider',
              revision: summaryChanged ? prev.revision + 1 : prev.revision,
              summary: summaryChanged ? providerSummaryResult.summary : prev.summary,
              unavailableMessage: providerSummaryResult.unavailableMessage,
            };
          });
          return;
        }

        if (providerSummaryRetryTimeoutRef.current !== null) {
          window.clearTimeout(providerSummaryRetryTimeoutRef.current);
          providerSummaryRetryTimeoutRef.current = null;
        }
        providerSummaryRetryAttemptsRef.current = 0;
        const nextSummary = providerSummaryResult.summary;
        const nextSource: SessionDiffSummaryState['source'] = 'provider';
        setState((prev) => {
          if (areSessionDiffSummariesEqual(prev.summary, nextSummary)) {
            if (prev.ready && prev.source === nextSource) {
              return prev.unavailableMessage === undefined
                ? prev
                : { ...prev, unavailableMessage: undefined };
            }
            return { ...prev, ready: true, source: nextSource, unavailableMessage: undefined };
          }
          return {
            ...prev,
            ready: true,
            source: nextSource,
            revision: prev.revision + 1,
            summary: nextSummary,
            unavailableMessage: undefined,
          };
        });
      } catch (error) {
        console.error('Failed to load provider diff summary', { sessionId, error });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, fileProvider, fileProviderPending, diffInputsVersion, sessionId]);

  useEffect(() => {
    let cancelled = false;
    let acquiredStore = false;
    let releaseSync: (() => void) | null = null;
    let unsubscribe: (() => void) | null = null;
    let derivation: ReturnType<typeof createConversationDerivation<DiffInputEntry>> | null = null;

    historyRef.current = undefined;
    diffInputsFingerprintRef.current = undefined;
    setDiffInputsVersion((prev) => prev + 1);
    setState(INITIAL_STATE);

    if (!enabled || !runtime) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const store = await runtime.acquireSessionStore(sessionId);
        acquiredStore = true;
        if (cancelled) {
          runtime.releaseSessionStoreRef(sessionId);
          acquiredStore = false;
          return;
        }
        releaseSync = store.acquireSync();

        derivation = createConversationDerivation(store.history, deriveDiffInputEntry);
        const initialHistory = collectDiffInputs(store.history, derivation.facts) as never;
        historyRef.current = initialHistory;
        diffInputsFingerprintRef.current = computeSessionDiffInputsFingerprint(initialHistory);
        setDiffInputsVersion((prev) => prev + 1);
        if (shouldUpdateFallbackSummary()) {
          const initialSummary = buildSessionDiffSummary(initialHistory);
          setState({
            ready: true,
            synced: false,
            source: 'fallback',
            revision: 0,
            summary: initialSummary,
            unavailableMessage: undefined,
          });
        }

        void store.firstSynced
          .then(() => {
            if (!cancelled) {
              setState((prev) => (prev.synced ? prev : { ...prev, synced: true }));
            }
          })
          .catch(() => {
            // ignore
          });

        const activeDerivation = derivation;
        let frame: number | null = null;
        const applyDerivedHistory = () => {
          frame = null;
          if (cancelled) return;
          const nextHistory = collectDiffInputs(store.history, activeDerivation.facts) as never;
          const nextFingerprint = computeSessionDiffInputsFingerprint(nextHistory);
          if (nextFingerprint === diffInputsFingerprintRef.current) {
            return;
          }
          diffInputsFingerprintRef.current = nextFingerprint;
          historyRef.current = nextHistory;
          setDiffInputsVersion((prev) => prev + 1);
          if (!shouldUpdateFallbackSummary()) {
            return;
          }
          const nextSummary = buildSessionDiffSummary(nextHistory);
          setState((prev) => {
            if (areSessionDiffSummariesEqual(prev.summary, nextSummary)) {
              if (prev.source === 'fallback') {
                return prev.unavailableMessage === undefined
                  ? prev
                  : { ...prev, unavailableMessage: undefined };
              }
              return { ...prev, source: 'fallback', unavailableMessage: undefined };
            }
            return {
              ...prev,
              source: 'fallback',
              revision: prev.revision + 1,
              summary: nextSummary,
              unavailableMessage: undefined,
            };
          });
        };
        // Facts change at token rate while a turn streams; refresh once per frame.
        unsubscribe = activeDerivation.subscribe(() => {
          if (frame === null) frame = requestAnimationFrame(applyDerivedHistory);
        });
      } catch (error) {
        console.error('Failed to load session diff summary', { sessionId, error });
      }
    })();

    return () => {
      cancelled = true;
      derivation?.dispose();
      if (unsubscribe) {
        unsubscribe();
      }
      if (releaseSync) {
        releaseSync();
      }
      if (acquiredStore) {
        runtime.releaseSessionStoreRef(sessionId);
      }
    };
  }, [enabled, runtime, sessionId]);

  if (fileProvider !== null && state.source !== 'provider') {
    return {
      ...state,
      ready: false,
      source: 'initial',
      summary: EMPTY_SESSION_DIFF_SUMMARY,
      unavailableMessage: undefined,
    };
  }

  return state;
}
