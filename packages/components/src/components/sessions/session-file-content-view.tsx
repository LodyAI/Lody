import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Copy,
  Eye,
  EyeClosed,
  Loader2,
  MessageCircle,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  WrapText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  getMachineFlockLocalProjects,
  type CodeCollabContentUnavailableReason,
  type SessionId,
  type SessionMeta,
  type VisualAnnotationReferencePayload,
} from '@lody/shared';
import { useAtomValue, useSetAtom } from 'jotai';
import { cn } from '@/lib/utils';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { writeTextToClipboard } from '@/lib/clipboard';
import { useActiveVSCodeTheme, useResolvedTheme } from '../../theme-provider';
import {
  conversationFontSizeAtom,
  currentWorkspaceIdAtom,
  fileViewerWordWrapAtom,
  getMachineMetaByIdAtomFamily,
  userAtom,
} from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { runtimeAtom } from '@/atoms/runtime';
import {
  resolveSessionLocalFileSource,
  resolveSessionLocalProjectRootPath,
} from '@/lib/session-local-file-source';
import { useSessionFileActions } from '@/hooks/use-session-file-actions';
import { chooseSessionFileSurfaceSource } from '@/lib/session-file-source-selection';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import {
  createLocalProjectIpcFileTransport,
  createLocalProjectRpcFileTransport,
} from '@/lib/local-project-rpc-file-provider';
import { ScrollArea } from '@/ui/scroll-area';
import {
  hasSessionFileLspProvider,
  type SessionFileProvider,
  type SessionFileProviderEntry,
} from '@/lib/session-file-provider';
import type { CodeCollabTextChangeCheckResult } from '@/lib/code-collab-session-file-provider';
import {
  sessionFileOpenResultToContentLoadResult,
  type SessionFileContentSnapshot,
} from '@/lib/session-file-content-snapshot';
import { normalizePinnedProviderOpenResult } from '@/lib/session-file-provider-open-result';
import { SessionFileBinaryPreview } from './session-file-binary-preview';
import { SessionFileImagePreview } from './session-file-image-preview';
import { MarkdownRenderer } from '../ai-gui/markdown-renderer';
import { isSvgPath } from '@/lib/image-file-preview';
import { logCodeCollabDebug } from '@/lib/code-collab-debug';
import {
  decideCodeCollabLiveTextUpdate,
  RecentLocalTextEchoTracker,
} from '@/lib/code-collab-live-text-update';
import { getSessionFileMonacoLanguageId, isSessionMarkdownPath } from '@/lib/session-file-language';
import { useCodeCollabLiveText } from '@/hooks/use-code-collab-live-text';
import { useMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import {
  SessionMonacoTextViewer,
  type SessionMonacoExternalTextUpdate,
} from './session-monaco-text-viewer';
import {
  useCodeCollabSaveText,
  type SessionFileLiveSyncStatus,
  type SessionFileSaveStatus,
} from '@/hooks/use-code-collab-save-text';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { useCodeCollabLsp, type CodeCollabLspState } from '@/hooks/use-code-collab-lsp';
import { useLatestRef } from '@/hooks/use-latest-ref';
import {
  buildCodeCollabMonacoUri,
  registerCodeCollabMonacoModelProvider,
} from '@/lib/session-monaco-language-providers';
import {
  normalizeSessionMonacoSelectedLines,
  type SessionMonacoSelectedLines,
} from '@/lib/session-monaco-viewer-state';
import type { SessionMonacoSelectionRestore } from '@/lib/session-monaco-editor-controller';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { FamiconsCloudOfflineOutline } from '@/components/icons/famicons-cloud-offline-outline';
import { SessionFileErrorState } from './session-file-error-state';
import { ManagedPreviewSurface } from './managed-preview-surface';
import { supportsCredentiallessManagedPreviewFrames } from './managed-preview-frame-cache';
import {
  buildStaticHtmlPreviewDocument,
  getStaticHtmlPreviewLogicalUrl,
} from './static-html-preview-document';

type ViewData =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: SessionFileContentSnapshot }
  | {
      status: 'error';
      message: string;
      reason?: CodeCollabContentUnavailableReason;
    };

type ProviderEditorSelectionState = {
  readonly anchorOffset: number;
  readonly headOffset: number;
  readonly isEmpty: boolean;
};

type StableProviderEditorSelection = {
  readonly fileId: string;
  readonly anchorOffset: number;
  readonly headOffset: number;
};

type CodeCollabTextChangeChecker = {
  checkTextChanged(pathOrFileId: string): Promise<CodeCollabTextChangeCheckResult>;
};

export type SessionFileSaveViewState = {
  readonly dirty: boolean;
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly error: boolean;
};

const EMPTY_SESSION_FILE_SAVE_VIEW_STATE: SessionFileSaveViewState = {
  dirty: false,
  canSave: false,
  saving: false,
  conflict: false,
  error: false,
};

export type SessionFileContentViewProps = {
  sessionId: SessionId;
  session: SessionMeta;
  filePath: string;
  fileId?: string;
  startLine?: number;
  endLine?: number;
  focusRequestSeq?: number;
  /** Explicit user request to enter rendered HTML for this open action. */
  htmlPreviewRequestSeq?: number;
  saveRequestSeq?: number;
  copyMarkdownRequestSeq?: number;
  /**
   * Mobile file drawers use the platform text surface for Markdown source so
   * long-press opens the OS selection controls instead of Monaco's desktop
   * context menu. Rendered Markdown opts into native selection as well.
   */
  preferNativeMarkdownSelection?: boolean;
  className?: string;
  active?: boolean;
  fileProvider?: SessionFileProvider | null;
  fileProviderPending?: boolean;
  fileProviderMessage?: string;
  // Role granted by the provider for the current participant. When the
  // file provider's role is `write` or `host`, a live-collaborative text
  // file is rendered through an editable Monaco surface; every other
  // role / source-state combination keeps the viewer read-only.
  fileProviderRole?: import('@lody/shared').CodeCollabRole;
  // Fired when the editable provider surface changes save-related state.
  // The parent tab shell uses this to show dirty/saving/conflict indicators
  // and to decide whether the active file can respond to Cmd/Ctrl+S.
  onSaveStateChange?: (state: SessionFileSaveViewState) => void;
  // Fired by the inline LSP panel when the user clicks a cross-file
  // result. The container (session-detail) routes this through the
  // viewer-tab manager so the target file replaces / opens alongside
  // the current tab. Unwired: cross-file LSP results render as plain
  // text in the panel (current pre-cross-file-nav behavior).
  onOpenFile?: (target: {
    readonly filePath: string;
    readonly fileId?: string;
    readonly line?: number;
    readonly character?: number;
  }) => void;
  visualAnnotationReferenceKeys?: readonly string[];
  onAddVisualAnnotationToChat?: (reference: VisualAnnotationReferencePayload) => boolean | void;
  onToggleVisualAnnotationInChat?: (reference: VisualAnnotationReferencePayload) => boolean | void;
};

const isHtmlPath = (filePath: string): boolean => /\.(?:html|htm)$/iu.test(filePath);

// The local-project read defaults to a 64 KiB PREVIEW budget, which is right
// for a mention popover and wrong for the file viewer — it truncated anything
// past 64 KiB behind a banner. Ask for the machine's whole allowance instead;
// it clamps this to its own hard ceiling.
const LOCAL_FILE_VIEWER_READ_MAX_BYTES = 5 * 1024 * 1024;

function getCodeCollabTextChangeChecker(
  provider: SessionFileProvider
): CodeCollabTextChangeChecker | null {
  return typeof (provider as Partial<CodeCollabTextChangeChecker>).checkTextChanged === 'function'
    ? (provider as unknown as CodeCollabTextChangeChecker)
    : null;
}

function SessionFileContentViewImpl({
  sessionId,
  session,
  filePath,
  fileId,
  startLine,
  endLine,
  focusRequestSeq,
  htmlPreviewRequestSeq,
  saveRequestSeq,
  copyMarkdownRequestSeq,
  preferNativeMarkdownSelection = false,
  className,
  active = true,
  fileProvider,
  fileProviderPending,
  fileProviderMessage,
  fileProviderRole,
  onSaveStateChange,
  onOpenFile,
  visualAnnotationReferenceKeys,
  onAddVisualAnnotationToChat,
  onToggleVisualAnnotationInChat,
}: SessionFileContentViewProps) {
  const { t } = useTranslation();
  const tRef = useLatestRef(t);
  const onSaveStateChangeRef = useLatestRef(onSaveStateChange);
  const activeVSCodeTheme = useActiveVSCodeTheme();
  const resolvedTheme = useResolvedTheme();
  // Global, persisted line-wrap preference. The Monaco viewer reads the same
  // atom; the top-bar toggle only needs the value + setter to reflect/flip it.
  const wordWrapEnabled = useAtomValue(fileViewerWordWrapAtom);
  const setWordWrapEnabled = useSetAtom(fileViewerWordWrapAtom);
  // Match the main conversation Markdown typography (settings → font size).
  const conversationFontSize = useAtomValue(conversationFontSizeAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceRuntime = useAtomValue(runtimeAtom);
  const effectiveWorkspaceId = resolveEffectiveCodeCollabWorkspaceId({
    currentWorkspaceId: workspaceId,
    runtimeWorkspaceId: workspaceRuntime?.workspaceId,
  });
  const sessionMachine = useAtomValue(getMachineMetaByIdAtomFamily(session.machineId));
  const machineFlockRows = useMachineFlockRows(session.machineId, {
    families: ['localProject'],
  });
  const sessionFileActions = useSessionFileActions({ session, fileProvider });
  const sessionMachineLocalProjects = useMemo(
    () => ({
      ...(sessionMachine?.localProjects ?? {}),
      ...getMachineFlockLocalProjects(machineFlockRows),
    }),
    [machineFlockRows, sessionMachine?.localProjects]
  );
  const sessionMachineOnlineStatus = useMachineOnlineStatus(session.machineId);
  const isSessionMachineOffline = !sessionMachine || sessionMachineOnlineStatus !== 'online';
  const localProjectRootPath = useMemo(
    () => resolveSessionLocalProjectRootPath(session, sessionMachineLocalProjects),
    [session, sessionMachineLocalProjects]
  );
  const localFileSource = useMemo(
    () =>
      resolveSessionLocalFileSource(session, {
        isElectronRenderer: typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true,
        localMachineId,
        workspaceId: effectiveWorkspaceId,
        localProjectRootPath,
      }),
    [effectiveWorkspaceId, localMachineId, localProjectRootPath, session]
  );
  const localFileSourceKind = localFileSource?.kind ?? null;
  const localProjectWorkspaceId =
    localFileSource?.kind === 'local-project' ? localFileSource.workspaceId : null;
  const localProjectMachineId =
    localFileSource?.kind === 'local-project' ? session.machineId : null;
  const localProjectId =
    localFileSource?.kind === 'local-project' ? localFileSource.localProjectId : null;
  const localWorktreeRepoKey =
    localFileSource?.kind === 'session-worktree' ? localFileSource.repoKey : null;
  const localWorktreeSessionId =
    localFileSource?.kind === 'session-worktree' ? localFileSource.sessionId : null;
  const fileContentSource = chooseSessionFileSurfaceSource({
    hasFileProvider: Boolean(fileProvider),
    fileProviderPending,
    hasLocalFileSource: Boolean(localFileSource),
    allowLocalFileSource: fileProviderPending !== true,
  });
  const shouldUseLocalFileContent = fileContentSource === 'local';
  const shouldUseProviderFileContent = fileContentSource === 'provider';
  const shouldWaitForFileProvider = fileContentSource === 'provider-pending';
  const shouldShowUnavailableFileContent = fileContentSource === 'unavailable';
  const isActiveSurface = active !== false;
  const [data, setData] = useState<ViewData>({ status: 'loading' });
  const [providerEntry, setProviderEntry] = useState<SessionFileProviderEntry | null>(null);
  // SVG is text, so it is shown in the code viewer by default but can be toggled
  // to a rendered preview.
  const [svgRenderMode, setSvgRenderMode] = useState<'rendered' | 'code'>('rendered');
  // Markdown opens as a rendered document by default, matching SVG previews.
  // The source remains one toggle away in the editable source surface.
  const [markdownRenderMode, setMarkdownRenderMode] = useState<'rendered' | 'code'>('rendered');
  // HTML starts as source because entering preview executes its inline scripts.
  const [htmlRenderMode, setHtmlRenderMode] = useState<'rendered' | 'code'>('code');
  const handledHtmlPreviewRequestSeqRef = useRef<number | undefined>(undefined);
  const [htmlAnnotationEnabled, setHtmlAnnotationEnabled] = useState(false);
  const [htmlAnnotationAvailable, setHtmlAnnotationAvailable] = useState(false);
  const [htmlPreviewLoading, setHtmlPreviewLoading] = useState(false);
  const [htmlRuntimeError, setHtmlRuntimeError] = useState<string | null>(null);
  const [htmlPreviewCommand, setHtmlPreviewCommand] = useState<
    { id: number; action: 'reload' } | undefined
  >(undefined);
  useEffect(() => {
    if (
      htmlPreviewRequestSeq === undefined ||
      handledHtmlPreviewRequestSeqRef.current === htmlPreviewRequestSeq
    ) {
      return;
    }
    handledHtmlPreviewRequestSeqRef.current = htmlPreviewRequestSeq;
    setHtmlAnnotationEnabled(false);
    setHtmlRenderMode('rendered');
  }, [htmlPreviewRequestSeq]);
  // Incremented by the top-bar search button to open Monaco's find widget.
  const [findRequestSeq, setFindRequestSeq] = useState(0);
  // Soft refresh: keep the current body mounted; only the toolbar button spins.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const providerEditorDirtyRef = useRef(false);
  const providerEditorDirtyTargetKeyRef = useRef<string | null>(null);
  const markProviderConflictPendingRef = useRef<((message?: string) => void) | null>(null);

  const normalizedPath = useMemo(() => filePath.trim(), [filePath]);
  const selectedLines = useMemo<SessionMonacoSelectedLines>(
    () => createSelectedLines(startLine, endLine, focusRequestSeq),
    [endLine, focusRequestSeq, startLine]
  );

  // Lody refuses to render some files it can locate perfectly well — too large,
  // unsupported encoding, one endless line. The error state then says "open it
  // on the host machine", so it also carries the ways to do that. Which ones
  // exist is `useSessionFileActions`' call, shared with the file tree context
  // menu and the side panel ⋯ menu: copying the path works anywhere, handing
  // the file to the OS needs the desktop bridge and this machine.
  const fileErrorActions = sessionFileActions.buildErrorActions(normalizedPath);
  const contentTargetKey = [
    fileContentSource,
    localFileSourceKind ?? '',
    localProjectWorkspaceId ?? '',
    localProjectId ?? '',
    localWorktreeRepoKey ?? '',
    localWorktreeSessionId ?? '',
    normalizedPath,
    fileId ?? '',
  ].join('\u0000');
  if (providerEditorDirtyTargetKeyRef.current !== contentTargetKey) {
    providerEditorDirtyTargetKeyRef.current = contentTargetKey;
    providerEditorDirtyRef.current = false;
  }

  useEffect(() => {
    setData({ status: 'loading' });
    setProviderEntry(null);
    setIsRefreshing(false);
  }, [
    localFileSourceKind,
    localProjectWorkspaceId,
    localProjectId,
    localWorktreeRepoKey,
    localWorktreeSessionId,
    normalizedPath,
    fileId,
    shouldUseLocalFileContent,
    shouldUseProviderFileContent,
    shouldWaitForFileProvider,
  ]);

  useEffect(() => {
    if (!isActiveSurface || data.status !== 'ready') return undefined;
    const snapshot = data.snapshot;
    logCodeCollabDebug('file content ready committed', {
      sessionId,
      filePath: normalizedPath,
      ...(fileId === undefined ? {} : { fileId }),
      snapshotKind: snapshot.kind,
      textLength: snapshot.kind === 'text' ? snapshot.text.length : undefined,
    });
    if (typeof window === 'undefined') return undefined;
    const frame = window.requestAnimationFrame(() => {
      logCodeCollabDebug('file content ready painted', {
        sessionId,
        filePath: normalizedPath,
        ...(fileId === undefined ? {} : { fileId }),
        snapshotKind: snapshot.kind,
        textLength: snapshot.kind === 'text' ? snapshot.text.length : undefined,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [data, fileId, isActiveSurface, normalizedPath, sessionId]);

  useEffect(() => {
    if (!normalizedPath) return undefined;
    if (!isActiveSurface) return undefined;
    if (shouldWaitForFileProvider) return undefined;

    if (shouldShowUnavailableFileContent) {
      setData({
        status: 'error',
        message:
          fileProviderMessage ??
          tRef.current('sessions.codeSession.files.unavailable', 'Files are unavailable.'),
      });
      return undefined;
    }

    let cancelled = false;
    const loadStartedAt = Date.now();
    const loadDebugContext = {
      sessionId,
      filePath: normalizedPath,
      ...(fileId === undefined ? {} : { fileId }),
      source: fileContentSource,
    };
    logCodeCollabDebug('file content load start', loadDebugContext);

    void (async () => {
      try {
        if (shouldUseLocalFileContent) {
          if (!localFileSourceKind) {
            throw new Error(
              tRef.current('sessions.codeSession.files.unavailable', 'Files are unavailable.')
            );
          }

          const readResult =
            localFileSourceKind === 'local-project' && localProjectWorkspaceId && localProjectId
              ? (() => {
                  const canUseIpc =
                    Boolean(getIpcServices()) &&
                    (!localProjectMachineId || localProjectMachineId === localMachineId);
                  if (canUseIpc) {
                    return createLocalProjectIpcFileTransport({
                      workspaceId: localProjectWorkspaceId,
                      localProjectId,
                    }).readFile({
                      relativePath: normalizedPath,
                      maxBytes: LOCAL_FILE_VIEWER_READ_MAX_BYTES,
                    });
                  }
                  if (!workspaceRuntime || !currentUserId || !localProjectMachineId) {
                    throw new Error(
                      tRef.current(
                        'sessions.localProject.files.apiUnavailable',
                        'Local file API is unavailable.'
                      )
                    );
                  }
                  return createLocalProjectRpcFileTransport({
                    workspaceId: localProjectWorkspaceId,
                    machineId: localProjectMachineId,
                    localProjectId,
                    requestedByUserId: currentUserId,
                    requestLocalProjectControl: (request, requestOptions) =>
                      workspaceRuntime.requestLocalProjectControl(request, requestOptions),
                  }).readFile({
                    relativePath: normalizedPath,
                    maxBytes: LOCAL_FILE_VIEWER_READ_MAX_BYTES,
                  });
                })()
              : (() => {
                  const reader = getIpcServices()?.localProjects.readSessionWorktreeFile.bind(
                    getIpcServices()!.localProjects
                  );
                  if (!reader) {
                    throw new Error(
                      tRef.current(
                        'sessions.worktree.files.apiUnavailable',
                        'Local worktree file API is unavailable.'
                      )
                    );
                  }
                  if (!localWorktreeRepoKey || !localWorktreeSessionId) {
                    throw new Error(
                      tRef.current(
                        'sessions.worktree.files.unavailable',
                        'Session worktree is unavailable.'
                      )
                    );
                  }
                  return reader(localWorktreeRepoKey, localWorktreeSessionId, normalizedPath, {
                    maxBytes: LOCAL_FILE_VIEWER_READ_MAX_BYTES,
                  });
                })();

          const result = await readResult;
          if (cancelled) return;
          logCodeCollabDebug('file content local read completed', {
            ...loadDebugContext,
            durationMs: Date.now() - loadStartedAt,
            snapshotKind: result ? 'text' : 'missing',
            textLength: result?.content?.length,
            truncated: result?.truncated,
          });
          setData({
            status: 'ready',
            snapshot: result
              ? { kind: 'text', text: result.content ?? '', truncated: result.truncated }
              : { kind: 'missing' },
          });
          return;
        }

        if (shouldUseProviderFileContent && fileProvider) {
          const providerOpenStartedAt = Date.now();
          const providerState = fileProvider.getState();
          if (providerEditorDirtyRef.current) {
            const changeChecker = getCodeCollabTextChangeChecker(fileProvider);
            if (changeChecker) {
              const result = await changeChecker.checkTextChanged(fileId ?? normalizedPath);
              if (cancelled) return;
              if (result.status === 'changed') {
                markProviderConflictPendingRef.current?.(
                  result.message ??
                    tRef.current(
                      'sessions.fileSave.compactConflictPending',
                      'External change detected'
                    )
                );
              }
            }
            logCodeCollabDebug('file content provider open skipped because editor is dirty', {
              ...loadDebugContext,
              providerKind: fileProvider.kind,
              providerReady: providerState.ready,
              providerSourceState: providerState.sourceState,
            });
            return;
          }
          logCodeCollabDebug('file content provider open start', {
            ...loadDebugContext,
            providerKind: fileProvider.kind,
            providerReady: providerState.ready,
            providerSourceState: providerState.sourceState,
          });
          const result = normalizePinnedProviderOpenResult(
            await fileProvider.openFile(fileId ?? normalizedPath),
            {
              ...(fileId === undefined ? {} : { fileId }),
              path: normalizedPath,
              providerState,
            }
          );
          if (cancelled) return;
          logCodeCollabDebug('file content provider open completed', {
            ...loadDebugContext,
            providerKind: fileProvider.kind,
            status: result.status,
            snapshotKind: result.status === 'ready' ? result.snapshot.kind : undefined,
            textLength:
              result.status === 'ready' && result.snapshot.kind === 'text'
                ? result.snapshot.text.length
                : undefined,
            unavailableReason: result.status === 'unavailable' ? result.reason : undefined,
            providerDurationMs: Date.now() - providerOpenStartedAt,
            durationMs: Date.now() - loadStartedAt,
          });
          setProviderEntry(result.entry ?? null);
          setData(sessionFileOpenResultToContentLoadResult(result));
          return;
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logCodeCollabDebug('file content load failed', {
          ...loadDebugContext,
          durationMs: Date.now() - loadStartedAt,
          message,
        });
        setData({ status: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    fileContentSource,
    fileProviderMessage,
    currentUserId,
    localFileSourceKind,
    localMachineId,
    localProjectMachineId,
    localProjectWorkspaceId,
    localProjectId,
    localWorktreeRepoKey,
    localWorktreeSessionId,
    normalizedPath,
    fileProvider,
    fileId,
    isActiveSurface,
    shouldShowUnavailableFileContent,
    shouldUseLocalFileContent,
    shouldUseProviderFileContent,
    shouldWaitForFileProvider,
    sessionId,
    tRef,
    workspaceRuntime,
  ]);

  // Compute editability for the provider Monaco surface. The viewer stays
  // read-only unless every condition below holds:
  // 1. provider currently sources content (code-collab live path),
  // 2. file is text + not flagged readonly + has no unavailable reason,
  // 3. source is `live-collaborative` (serving machine reachable),
  // 4. caller role authorises writes (`host` or `write`).
  const isProviderFileWritable =
    shouldUseProviderFileContent &&
    providerEntry?.kind === 'text' &&
    providerEntry.readonly !== true &&
    providerEntry.sourceState === 'live-collaborative' &&
    providerEntry.unavailableReason === undefined &&
    (fileProviderRole === 'host' || fileProviderRole === 'write');
  const isProviderFileEditable = isActiveSurface && isProviderFileWritable;

  const editableFileId = isProviderFileWritable ? (providerEntry?.fileId ?? fileId ?? null) : null;

  // Text feed for the provider surface. In v2 this is driven by the
  // path-keyed provider cache plus explicit refresh/save RPC responses.
  const liveFileId =
    shouldUseProviderFileContent && providerEntry?.kind === 'text'
      ? (providerEntry.fileId ?? fileId ?? null)
      : null;
  const [externalTextUpdate, setExternalTextUpdate] = useState<
    SessionMonacoExternalTextUpdate | undefined
  >(undefined);
  const externalSeqRef = useRef(0);
  const latestEditorTextRef = useRef<string | undefined>(undefined);
  const latestStableSelectionRef = useRef<StableProviderEditorSelection | null>(null);
  const recentLocalTextEchoTrackerRef = useRef(new RecentLocalTextEchoTracker());
  const hasAcceptedLocalContentChangeRef = useRef(false);
  const preservePendingOnNextExternalTextAppliedRef = useRef(false);

  const handleLocalLiveTextSynced = useCallback(
    (text: string, syncedFileId: string) => {
      if (syncedFileId !== editableFileId) return;
      latestEditorTextRef.current = text;
    },
    [editableFileId]
  );

  const {
    status: saveStatus,
    liveStatus,
    onContentChange: handleEditorContentChange,
    onExternalTextApplied: handleExternalTextAppliedToSaveState,
    markConflictPending: markProviderConflictPending,
    flush: saveProviderEditorText,
    resolveConflict: rawResolveConflict,
  } = useCodeCollabSaveText({
    provider: shouldUseProviderFileContent ? fileProvider : null,
    fileId: liveFileId,
    enabled: isProviderFileWritable,
    onLiveTextSynced: handleLocalLiveTextSynced,
  });

  useEffect(() => {
    setExternalTextUpdate(undefined);
    latestEditorTextRef.current = undefined;
    latestStableSelectionRef.current = null;
    recentLocalTextEchoTrackerRef.current.clear();
    hasAcceptedLocalContentChangeRef.current = false;
  }, [liveFileId]);

  const openedLiveText =
    shouldUseProviderFileContent && data.status === 'ready' && data.snapshot.kind === 'text'
      ? data.snapshot.text
      : undefined;

  useEffect(() => {
    if (openedLiveText === undefined) return;
    latestEditorTextRef.current = openedLiveText;
  }, [liveFileId, openedLiveText]);

  const liveTextUpdate = useCodeCollabLiveText(
    shouldUseProviderFileContent ? fileProvider : null,
    liveFileId,
    {
      enabled:
        isActiveSurface &&
        shouldUseProviderFileContent &&
        data.status === 'ready' &&
        data.snapshot.kind === 'text',
    }
  );
  useEffect(() => {
    if (!liveTextUpdate) return;
    const decision = decideCodeCollabLiveTextUpdate({
      incomingText: liveTextUpdate.text,
      currentEditorText: latestEditorTextRef.current,
      isRecentLocalEcho: recentLocalTextEchoTrackerRef.current.has(liveTextUpdate.text),
    });
    if (decision.kind === 'ack-current') {
      latestEditorTextRef.current = decision.text;
      return;
    }
    if (decision.kind === 'ignore-local-echo') {
      if (latestEditorTextRef.current === undefined) {
        latestEditorTextRef.current = decision.text;
      }
      logCodeCollabDebug('live text update ignored because it matches a recent local edit', {
        sessionId,
        filePath: normalizedPath,
        fileId: liveFileId,
        seq: liveTextUpdate.seq,
      });
      return;
    }
    externalSeqRef.current += 1;
    const restoreSelection = resolveStableProviderEditorSelection({
      fileId: liveFileId,
      selection: latestStableSelectionRef.current,
    });
    setExternalTextUpdate({
      seq: externalSeqRef.current,
      text: decision.text,
      ...(restoreSelection === undefined ? {} : { restoreSelection }),
    });
  }, [liveFileId, liveTextUpdate, normalizedPath, sessionId]);

  const handleProviderEditorContentChange = useCallback(
    (text: string) => {
      if (latestEditorTextRef.current === text) return;
      if (!hasAcceptedLocalContentChangeRef.current && text === openedLiveText) {
        latestEditorTextRef.current = text;
        return;
      }
      hasAcceptedLocalContentChangeRef.current = true;
      latestEditorTextRef.current = text;
      recentLocalTextEchoTrackerRef.current.remember(text);
      providerEditorDirtyRef.current = true;
      handleEditorContentChange(text);
    },
    [handleEditorContentChange, openedLiveText]
  );

  const handleExternalTextUpdateApplied = useCallback(
    (result: 'applied' | 'no-op') => {
      if (result === 'applied') {
        if (externalTextUpdate) {
          latestEditorTextRef.current = externalTextUpdate.text;
        }
        if (preservePendingOnNextExternalTextAppliedRef.current) {
          preservePendingOnNextExternalTextAppliedRef.current = false;
          return;
        }
        providerEditorDirtyRef.current = false;
        handleExternalTextAppliedToSaveState();
        return;
      }
      if (result === 'no-op') {
        if (externalTextUpdate) {
          latestEditorTextRef.current = externalTextUpdate.text;
        }
        return;
      }
    },
    [externalTextUpdate, handleExternalTextAppliedToSaveState]
  );

  const handleSaveConflictResolve = useCallback(
    async (resolution: 'override' | 'discard' | 'load_with_conflicts'): Promise<void> => {
      if (resolution !== 'load_with_conflicts') {
        await rawResolveConflict(resolution);
        return;
      }
      preservePendingOnNextExternalTextAppliedRef.current = true;
      try {
        await rawResolveConflict(resolution);
      } catch (error) {
        preservePendingOnNextExternalTextAppliedRef.current = false;
        throw error;
      }
    },
    [rawResolveConflict]
  );

  const handleProviderEditorSelectionChange = useCallback(
    (state: ProviderEditorSelectionState) => {
      if (liveFileId) {
        latestStableSelectionRef.current = createStableProviderEditorSelection({
          fileId: liveFileId,
          selection: state,
        });
      } else {
        latestStableSelectionRef.current = null;
      }
    },
    [liveFileId]
  );

  const isTextFileReady = data.status === 'ready' && data.snapshot.kind === 'text';
  const supportsHtmlPreview = supportsCredentiallessManagedPreviewFrames();
  const htmlPreviewSource =
    supportsHtmlPreview &&
    data.status === 'ready' &&
    data.snapshot.kind === 'text' &&
    data.snapshot.truncated !== true &&
    isHtmlPath(normalizedPath)
      ? (latestEditorTextRef.current ?? data.snapshot.text)
      : null;
  const isHtmlTextFile = htmlPreviewSource !== null;
  const showHtmlRendered = isActiveSurface && isHtmlTextFile && htmlRenderMode === 'rendered';
  const htmlPreviewDocument = useMemo(
    () =>
      showHtmlRendered && htmlPreviewSource !== null
        ? buildStaticHtmlPreviewDocument(htmlPreviewSource)
        : null,
    [htmlPreviewSource, showHtmlRendered]
  );
  const htmlPreviewLogicalUrl = useMemo(
    () => getStaticHtmlPreviewLogicalUrl(normalizedPath),
    [normalizedPath]
  );

  useEffect(() => {
    if (showHtmlRendered) return;
    setHtmlAnnotationEnabled(false);
    setHtmlAnnotationAvailable(false);
    setHtmlPreviewLoading(false);
    setHtmlRuntimeError(null);
    setHtmlPreviewCommand(undefined);
  }, [showHtmlRendered]);

  const handleHtmlAnnotationAvailabilityChange = useCallback((available: boolean) => {
    setHtmlAnnotationAvailable(available);
    if (!available) setHtmlAnnotationEnabled(false);
  }, []);
  const handleHtmlRuntimeError = useCallback((error: string | null) => {
    setHtmlRuntimeError(error);
  }, []);
  const handleHtmlPreviewLoadingChange = useCallback((loading: boolean) => {
    setHtmlPreviewLoading(loading);
  }, []);
  const handleHtmlBrowserStateChange = useCallback(() => undefined, []);
  const handleHtmlNavigationRequest = useCallback(() => {
    setHtmlAnnotationEnabled(false);
    setHtmlRenderMode('code');
    toast.warning(
      tRef.current(
        'sessions.fileViewer.htmlPreview.navigationDisabled',
        'Navigation is disabled for self-contained HTML previews.'
      )
    );
  }, [tRef]);
  const isProviderEditorDirty =
    saveStatus.kind === 'pending' ||
    saveStatus.kind === 'saving' ||
    saveStatus.kind === 'error' ||
    saveStatus.kind === 'conflict_pending' ||
    saveStatus.kind === 'conflict';
  markProviderConflictPendingRef.current = markProviderConflictPending;
  useEffect(() => {
    if (saveStatus.kind === 'saved') {
      providerEditorDirtyRef.current = false;
    }
  }, [saveStatus.kind]);
  const canSaveProviderEditor =
    isProviderFileEditable &&
    (saveStatus.kind === 'pending' ||
      saveStatus.kind === 'error' ||
      saveStatus.kind === 'conflict_pending');
  const handleProviderSave = useCallback(() => {
    if (!canSaveProviderEditor) return;
    void saveProviderEditorText();
  }, [canSaveProviderEditor, saveProviderEditorText]);
  const lastSaveRequestSeqRef = useRef(saveRequestSeq ?? 0);
  useEffect(() => {
    if (saveRequestSeq === undefined || saveRequestSeq === lastSaveRequestSeqRef.current) {
      return;
    }
    lastSaveRequestSeqRef.current = saveRequestSeq;
    if (!canSaveProviderEditor) return;
    void saveProviderEditorText();
  }, [canSaveProviderEditor, saveProviderEditorText, saveRequestSeq]);

  const handleCopyMarkdown = useCallback(async () => {
    if (
      data.status !== 'ready' ||
      data.snapshot.kind !== 'text' ||
      !isSessionMarkdownPath(normalizedPath)
    ) {
      return;
    }
    if (data.snapshot.truncated === true) {
      toast.error(
        tRef.current(
          'sessions.fileViewer.markdownCopyTruncated',
          'Full Markdown is unavailable because this preview is truncated'
        )
      );
      return;
    }
    const markdown = latestEditorTextRef.current ?? data.snapshot.text;
    const copied = await writeTextToClipboard(markdown);
    if (copied) {
      toast.success(tRef.current('sessions.fileViewer.markdownCopied', 'Markdown copied'));
    } else {
      toast.error(
        tRef.current('sessions.fileViewer.markdownCopyFailed', 'Failed to copy Markdown')
      );
    }
  }, [data, normalizedPath, tRef]);
  const lastCopyMarkdownRequestSeqRef = useRef(copyMarkdownRequestSeq ?? 0);
  useEffect(() => {
    if (
      copyMarkdownRequestSeq === undefined ||
      copyMarkdownRequestSeq === lastCopyMarkdownRequestSeqRef.current
    ) {
      return;
    }
    if (
      data.status !== 'ready' ||
      data.snapshot.kind !== 'text' ||
      !isSessionMarkdownPath(normalizedPath)
    ) {
      return;
    }
    lastCopyMarkdownRequestSeqRef.current = copyMarkdownRequestSeq;
    void handleCopyMarkdown();
  }, [copyMarkdownRequestSeq, data, handleCopyMarkdown, normalizedPath]);
  const saveViewState = useMemo<SessionFileSaveViewState>(
    () => ({
      dirty: isProviderEditorDirty,
      canSave: canSaveProviderEditor,
      saving: saveStatus.kind === 'saving',
      conflict: saveStatus.kind === 'conflict' || saveStatus.kind === 'conflict_pending',
      error: saveStatus.kind === 'error',
    }),
    [canSaveProviderEditor, isProviderEditorDirty, saveStatus.kind]
  );
  useEffect(() => {
    onSaveStateChangeRef.current?.(saveViewState);
  }, [onSaveStateChangeRef, saveViewState]);
  useEffect(
    () => () => {
      onSaveStateChangeRef.current?.(EMPTY_SESSION_FILE_SAVE_VIEW_STATE);
    },
    [onSaveStateChangeRef]
  );
  const handleProviderRefresh = useCallback(() => {
    if (!fileProvider || !shouldUseProviderFileContent || !isTextFileReady) return;
    if (isProviderEditorDirty || isRefreshing) return;
    setIsRefreshing(true);
    void fileProvider
      .openFile(fileId ?? normalizedPath)
      .then((result) => {
        const normalized = normalizePinnedProviderOpenResult(result, {
          ...(fileId === undefined ? {} : { fileId }),
          path: normalizedPath,
          providerState: fileProvider.getState(),
        });
        setProviderEntry(normalized.entry ?? null);
        const next = sessionFileOpenResultToContentLoadResult(normalized);
        setData(next);
        // Editable Monaco ignores plain `text` prop updates (local model is
        // source of truth). Push an external snapshot so refresh still lands
        // while the editor stays mounted (no full-page loading swap).
        if (next.status === 'ready' && next.snapshot.kind === 'text') {
          externalSeqRef.current += 1;
          latestEditorTextRef.current = next.snapshot.text;
          setExternalTextUpdate({
            seq: externalSeqRef.current,
            text: next.snapshot.text,
          });
        }
      })
      .catch((error) => {
        // Soft-fail: keep the previous ready body when one exists so a
        // transient refresh error does not blank the file view.
        setData((current) =>
          current.status === 'ready'
            ? current
            : {
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              }
        );
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  }, [
    fileId,
    fileProvider,
    isProviderEditorDirty,
    isRefreshing,
    isTextFileReady,
    normalizedPath,
    shouldUseProviderFileContent,
  ]);

  // LSP entry points. Enabled whenever the provider supplies content
  // for this view (including read-only mode — read roles can
  // still request LSP per spec L651). The hook handles the RPC round
  // trip and exposes a small state machine the inline panel renders.
  const lspFileId = providerEntry?.fileId ?? fileId ?? null;
  const isLspEnabled =
    isActiveSurface &&
    shouldUseProviderFileContent &&
    providerEntry?.kind === 'text' &&
    providerEntry.unavailableReason === undefined &&
    hasSessionFileLspProvider(fileProvider);
  const {
    state: lspState,
    onGoToDefinition: handleGoToDefinition,
    onFindReferences: handleFindReferences,
    dismiss: handleLspDismiss,
  } = useCodeCollabLsp({
    provider: shouldUseProviderFileContent ? fileProvider : null,
    fileId: lspFileId,
    enabled: isLspEnabled,
  });

  // Register the active provider against the global Code Collab Monaco
  // language-provider registry while this view is mounted. The registry
  // keys by fileId; the model URI carries it (`code-collab://<fileId>/<path>`)
  // so Cmd-click / F12 reach the right provider when multiple files are
  // open. Unregisters on unmount or when the active fileId / provider
  // changes so a stale entry can't intercept a different mount.
  const lspModelUri = useMemo(
    () =>
      isLspEnabled && lspFileId ? buildCodeCollabMonacoUri(lspFileId, normalizedPath) : undefined,
    [isLspEnabled, lspFileId, normalizedPath]
  );

  useEffect(() => {
    if (!isLspEnabled || !lspFileId || !fileProvider) return undefined;
    return registerCodeCollabMonacoModelProvider(lspFileId, fileProvider);
  }, [fileProvider, isLspEnabled, lspFileId]);

  let body: ReactNode;
  const showLocalLoading = shouldUseLocalFileContent && data.status === 'loading';
  const showProviderConnecting = shouldWaitForFileProvider;
  const isSvgTextFile =
    data.status === 'ready' && data.snapshot.kind === 'text' && isSvgPath(normalizedPath);
  const showSvgRendered = isSvgTextFile && svgRenderMode === 'rendered';
  const isMarkdownTextFile =
    data.status === 'ready' &&
    data.snapshot.kind === 'text' &&
    isSessionMarkdownPath(normalizedPath);
  const canCopyFullMarkdown =
    data.status === 'ready' &&
    data.snapshot.kind === 'text' &&
    isSessionMarkdownPath(normalizedPath) &&
    data.snapshot.truncated !== true;
  const showMarkdownRendered = isMarkdownTextFile && markdownRenderMode === 'rendered';
  // Source text for the rendered Markdown preview. Prefer the latest text the
  // editor has committed (local edits + applied live syncs) over the opened
  // snapshot, so toggling to `rendered` after editing shows the current
  // content rather than the original. Provider live-text updates that arrive
  // while the user is already in `rendered` mode are reflected after toggling
  // back to `code`, where Monaco applies the latest provider text.
  const markdownPreviewText =
    data.status === 'ready' && data.snapshot.kind === 'text'
      ? (latestEditorTextRef.current ?? data.snapshot.text)
      : '';
  // The rendered surface for a previewable text file (Markdown doc / SVG image).
  // Only shown after the user clicks the preview toggle — hover never mounts it.
  // Typography tracks conversationFontSize so side-panel README preview matches
  // the left chat Markdown (default = text-sm; was hard-coded large/"base").
  const previewSurface: ReactNode = isMarkdownTextFile ? (
    <div
      className="mx-auto w-full max-w-3xl px-3 py-3 select-text sm:px-4 sm:py-4"
      data-native-selection-allow
    >
      <MarkdownRenderer text={markdownPreviewText} size={conversationFontSize} />
    </div>
  ) : isSvgTextFile && data.status === 'ready' && data.snapshot.kind === 'text' ? (
    <SessionFileImagePreview path={normalizedPath} svgText={data.snapshot.text} />
  ) : null;
  const fileContentRenderBranch = showProviderConnecting
    ? 'provider-connecting'
    : showLocalLoading || data.status === 'loading'
      ? 'file-loading'
      : data.status === 'error'
        ? 'error'
        : data.snapshot.kind === 'binary'
          ? 'binary'
          : data.snapshot.kind === 'missing'
            ? 'missing'
            : shouldUseProviderFileContent
              ? 'provider-content'
              : 'local-content';
  const localFileLoadingLabel =
    localFileSourceKind === 'session-worktree'
      ? t('sessions.worktree.fileViewer.loading', 'Loading local worktree file…')
      : t('sessions.localProject.fileViewer.loading', 'Loading local file…');

  useEffect(() => {
    logCodeCollabDebug('file content source state', {
      sessionId,
      filePath: normalizedPath,
      fileId: fileId ?? null,
      source: fileContentSource,
      hasFileProvider: Boolean(fileProvider),
      providerKind: fileProvider?.kind ?? null,
      fileProviderPending: fileProviderPending === true,
      fileProviderMessage: fileProviderMessage ?? null,
      renderBranch: fileContentRenderBranch,
      localFileSourceKind,
      dataStatus: data.status,
      active: isActiveSurface,
    });
  }, [
    data.status,
    fileContentSource,
    fileContentRenderBranch,
    fileId,
    fileProvider,
    fileProviderMessage,
    fileProviderPending,
    isActiveSurface,
    localFileSourceKind,
    normalizedPath,
    sessionId,
  ]);

  if (showProviderConnecting) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-sm text-muted-foreground text-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          {fileProviderMessage ??
            t('sessions.codeSession.connecting', 'Connecting to code session…')}
        </span>
      </div>
    );
  } else if (showLocalLoading || data.status === 'loading') {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-sm text-muted-foreground text-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          {shouldUseLocalFileContent
            ? localFileLoadingLabel
            : t('sessions.fileViewer.loading', 'Loading file…')}
        </span>
      </div>
    );
  } else if (data.status === 'error') {
    body = (
      <SessionFileErrorState
        message={data.message}
        reason={data.reason}
        {...(fileErrorActions ? { fileActions: fileErrorActions } : {})}
      />
    );
  } else if (data.snapshot.kind === 'binary') {
    body = <SessionFileBinaryPreview path={normalizedPath} bytes={data.snapshot.bytes} />;
  } else if (data.snapshot.kind === 'missing') {
    body = (
      <SessionFileErrorState
        message={t('sessions.fileViewer.missing', 'File not found.')}
        reason="deleted"
      />
    );
  } else if (showHtmlRendered && htmlPreviewDocument !== null) {
    body = (
      <div className="relative h-full min-h-0 overflow-hidden bg-background">
        <ManagedPreviewSurface
          session={session}
          viewerUrl={htmlPreviewLogicalUrl}
          logicalUrl={htmlPreviewLogicalUrl}
          documentHtml={htmlPreviewDocument}
          annotationEnabled={htmlAnnotationEnabled}
          command={htmlPreviewCommand}
          className="h-full"
          visualAnnotationReferenceKeys={visualAnnotationReferenceKeys}
          onAnnotationAvailabilityChange={handleHtmlAnnotationAvailabilityChange}
          onRuntimeError={handleHtmlRuntimeError}
          onLoadingChange={handleHtmlPreviewLoadingChange}
          onBrowserStateChange={handleHtmlBrowserStateChange}
          onNavigationRequest={handleHtmlNavigationRequest}
          onAddVisualAnnotationToChat={onAddVisualAnnotationToChat}
          onToggleVisualAnnotationInChat={onToggleVisualAnnotationInChat}
        />
        {htmlPreviewLoading ? (
          <div className="pointer-events-none absolute right-3 top-3 rounded bg-background/90 p-1.5 text-muted-foreground shadow-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          </div>
        ) : null}
        {htmlRuntimeError ? (
          <div className="absolute bottom-3 left-3 right-3 flex items-start gap-2 rounded-md border border-status-warning/30 bg-background/95 px-3 py-2 text-xs text-foreground shadow-sm">
            <ShieldAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
              aria-hidden="true"
            />
            <span>{htmlRuntimeError}</span>
          </div>
        ) : null}
      </div>
    );
  } else if (showSvgRendered || showMarkdownRendered) {
    body = previewSurface;
  } else {
    if (shouldUseProviderFileContent) {
      body = (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            {isMarkdownTextFile && preferNativeMarkdownSelection ? (
              <NativeMarkdownSource
                key={liveFileId ?? normalizedPath}
                text={
                  hasAcceptedLocalContentChangeRef.current || isProviderEditorDirty
                    ? (latestEditorTextRef.current ?? data.snapshot.text)
                    : data.snapshot.text
                }
                readOnly={!isProviderFileEditable}
                wordWrap={wordWrapEnabled}
                selectedLines={selectedLines}
                externalTextUpdate={externalTextUpdate}
                onContentChange={
                  isProviderFileEditable ? handleProviderEditorContentChange : undefined
                }
                onSelectionChange={
                  liveFileId !== null ? handleProviderEditorSelectionChange : undefined
                }
                onExternalTextUpdateApplied={handleExternalTextUpdateApplied}
                ariaLabel={t('sessions.fileViewer.markdownSource', 'Markdown source')}
              />
            ) : (
              <LazyProviderTextMonacoViewer
                key={lspModelUri?.toString() ?? liveFileId ?? normalizedPath}
                text={
                  hasAcceptedLocalContentChangeRef.current || isProviderEditorDirty
                    ? (latestEditorTextRef.current ?? data.snapshot.text)
                    : data.snapshot.text
                }
                language={getSessionFileMonacoLanguageId(normalizedPath)}
                selectedLines={selectedLines}
                resolvedTheme={resolvedTheme}
                vscodeTheme={activeVSCodeTheme ?? null}
                readOnly={!isProviderFileEditable}
                onContentChange={
                  isProviderFileEditable ? handleProviderEditorContentChange : undefined
                }
                onSelectionChange={
                  liveFileId !== null ? handleProviderEditorSelectionChange : undefined
                }
                onGoToDefinition={isLspEnabled ? handleGoToDefinition : undefined}
                onFindReferences={isLspEnabled ? handleFindReferences : undefined}
                externalTextUpdate={externalTextUpdate}
                onExternalTextUpdateApplied={handleExternalTextUpdateApplied}
                findRequestSeq={findRequestSeq}
                modelUri={lspModelUri}
              />
            )}
          </div>
          {data.snapshot.truncated ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('sessions.localProject.fileViewer.truncated', 'File content was truncated.')}
            </div>
          ) : null}
          {isLspEnabled && lspState.kind !== 'idle' ? (
            <SessionFileLspPanel
              state={lspState}
              t={t}
              onDismiss={handleLspDismiss}
              currentFileId={lspFileId}
              onOpenLocation={onOpenFile}
            />
          ) : null}
        </div>
      );
    } else {
      body = (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            {isMarkdownTextFile && preferNativeMarkdownSelection ? (
              <NativeMarkdownSource
                key={normalizedPath}
                text={data.snapshot.text}
                readOnly
                wordWrap={wordWrapEnabled}
                selectedLines={selectedLines}
                ariaLabel={t('sessions.fileViewer.markdownSource', 'Markdown source')}
              />
            ) : (
              <LazyTextMonacoViewer
                key={normalizedPath}
                text={data.snapshot.text}
                language={getSessionFileMonacoLanguageId(normalizedPath)}
                selectedLines={selectedLines}
                resolvedTheme={resolvedTheme}
                vscodeTheme={activeVSCodeTheme ?? null}
                findRequestSeq={findRequestSeq}
                readOnly
              />
            )}
          </div>
          {data.snapshot.truncated ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {t('sessions.localProject.fileViewer.truncated', 'File content was truncated.')}
            </div>
          ) : null}
        </div>
      );
    }
  }

  const bodyUsesNativeScrolling = isTextFileReady && !showSvgRendered && !showMarkdownRendered;
  const showRealtimeStatusBar = shouldUseProviderFileContent || showProviderConnecting;
  // Top toolbar controls. The render-mode toggle moved here from the bottom
  // status bar (which now only carries save/live/offline state). The search
  // button only appears when a Monaco editor is mounted — a rendered SVG/Markdown
  // preview has no editor to search.
  const showPreviewToggle = isSvgTextFile || isMarkdownTextFile || isHtmlTextFile;
  const showSearchButton =
    isTextFileReady &&
    !showSvgRendered &&
    !showMarkdownRendered &&
    !showHtmlRendered &&
    !(isMarkdownTextFile && preferNativeMarkdownSelection);
  const showWordWrapButton =
    isTextFileReady && !showSvgRendered && !showMarkdownRendered && !showHtmlRendered;
  const showSaveButton = isProviderFileEditable && isTextFileReady;
  const showRefreshButton = shouldUseProviderFileContent && isTextFileReady;
  const showViewerTopBar =
    showPreviewToggle ||
    isMarkdownTextFile ||
    showSearchButton ||
    showSaveButton ||
    showRefreshButton;

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>
      {showViewerTopBar ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/50 bg-background px-2">
          <div className="ml-auto flex items-center gap-1">
            {showPreviewToggle ? (
              <FilePreviewToggle
                active={
                  isSvgTextFile
                    ? svgRenderMode === 'rendered'
                    : isMarkdownTextFile
                      ? markdownRenderMode === 'rendered'
                      : htmlRenderMode === 'rendered'
                }
                onToggle={() => {
                  if (isSvgTextFile) {
                    setSvgRenderMode((mode) => (mode === 'rendered' ? 'code' : 'rendered'));
                  } else if (isMarkdownTextFile) {
                    setMarkdownRenderMode((mode) => (mode === 'rendered' ? 'code' : 'rendered'));
                  } else {
                    setHtmlAnnotationEnabled(false);
                    setHtmlRenderMode((mode) => (mode === 'rendered' ? 'code' : 'rendered'));
                  }
                }}
                showLabel={
                  isHtmlTextFile
                    ? t('sessions.fileViewer.htmlPreview.show', 'Preview HTML (runs scripts)')
                    : t('sessions.fileViewer.preview.show', 'Preview')
                }
                hideLabel={t('sessions.fileViewer.preview.hide', 'Hide preview')}
              />
            ) : null}
            {isMarkdownTextFile ? (
              <button
                type="button"
                onClick={() => void handleCopyMarkdown()}
                disabled={!canCopyFullMarkdown}
                title={
                  canCopyFullMarkdown
                    ? t('sessions.fileViewer.copyMarkdown', 'Copy full Markdown')
                    : t(
                        'sessions.fileViewer.markdownCopyTruncated',
                        'Full Markdown is unavailable because this preview is truncated'
                      )
                }
                aria-label={t('sessions.fileViewer.copyMarkdown', 'Copy full Markdown')}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {showHtmlRendered ? (
              <button
                type="button"
                aria-pressed={htmlAnnotationEnabled}
                onClick={() => setHtmlAnnotationEnabled((enabled) => !enabled)}
                disabled={!htmlAnnotationAvailable}
                title={t('sessions.preview.annotation.addComment', 'Add comment')}
                aria-label={t('sessions.preview.annotation.addComment', 'Add comment')}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
                  htmlAnnotationEnabled ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {showHtmlRendered ? (
              <button
                type="button"
                onClick={() =>
                  setHtmlPreviewCommand((current) => ({
                    id: (current?.id ?? 0) + 1,
                    action: 'reload',
                  }))
                }
                title={t('sessions.browser.reload', 'Reload')}
                aria-label={t('sessions.browser.reload', 'Reload')}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {showWordWrapButton ? (
              <button
                type="button"
                aria-pressed={wordWrapEnabled}
                onClick={() => setWordWrapEnabled((enabled) => !enabled)}
                title={
                  wordWrapEnabled
                    ? t('sessions.fileViewer.wordWrapDisable', 'Disable line wrap')
                    : t('sessions.fileViewer.wordWrapEnable', 'Wrap long lines')
                }
                aria-label={t('sessions.fileViewer.wordWrap', 'Wrap lines')}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground',
                  wordWrapEnabled ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {showSearchButton ? (
              <button
                type="button"
                onClick={() => setFindRequestSeq((seq) => seq + 1)}
                title={t('sessions.fileViewer.search', 'Search')}
                aria-label={t('sessions.fileViewer.search', 'Search')}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {showSaveButton ? (
              <button
                type="button"
                onClick={handleProviderSave}
                disabled={!canSaveProviderEditor}
                title={
                  saveStatus.kind === 'conflict'
                    ? t('sessions.fileViewer.save.conflict', 'Resolve the save conflict first')
                    : t('sessions.fileViewer.save.withShortcut', 'Save (⌘S / Ctrl+S)')
                }
                aria-label={t('sessions.fileViewer.save', 'Save')}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50',
                  canSaveProviderEditor
                    ? 'text-status-warning hover:bg-status-warning/10 hover:text-status-warning'
                    : 'text-muted-foreground'
                )}
              >
                {saveStatus.kind === 'saving' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            ) : null}
            {showRefreshButton ? (
              <button
                type="button"
                onClick={handleProviderRefresh}
                disabled={isProviderEditorDirty || isRefreshing}
                title={
                  isProviderEditorDirty
                    ? t(
                        'sessions.fileViewer.refresh.dirty',
                        'Save or discard edits before refreshing'
                      )
                    : t('sessions.fileViewer.refresh', 'Refresh')
                }
                aria-label={t('sessions.fileViewer.refresh', 'Refresh')}
                aria-busy={isRefreshing}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
                  aria-hidden="true"
                />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {bodyUsesNativeScrolling ? (
          <div className="h-full min-h-0 min-w-0">{body}</div>
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="min-h-full min-w-0">{body}</div>
          </ScrollArea>
        )}
      </div>
      {isProviderFileEditable && saveStatus.kind === 'conflict' ? (
        <SessionFileConflictActionRow onResolveConflict={handleSaveConflictResolve} t={t} />
      ) : null}
      {showRealtimeStatusBar ? (
        <SessionFileRealtimeStatusBar
          saveStatus={saveStatus}
          liveStatus={liveStatus}
          showSaveStatus={isProviderFileEditable}
          machineOffline={
            showProviderConnecting || shouldUseProviderFileContent ? isSessionMachineOffline : false
          }
          t={t}
        />
      ) : null}
    </div>
  );
}

export const SessionFileContentView = memo(SessionFileContentViewImpl);

function NativeMarkdownSource({
  text,
  readOnly,
  wordWrap,
  selectedLines,
  externalTextUpdate,
  onContentChange,
  onSelectionChange,
  onExternalTextUpdateApplied,
  ariaLabel,
}: {
  readonly text: string;
  readonly readOnly: boolean;
  readonly wordWrap: boolean;
  readonly selectedLines?: SessionMonacoSelectedLines;
  readonly externalTextUpdate?: SessionMonacoExternalTextUpdate;
  readonly onContentChange?: (text: string) => void;
  readonly onSelectionChange?: (state: ProviderEditorSelectionState) => void;
  readonly onExternalTextUpdateApplied?: (result: 'applied' | 'no-op') => void;
  readonly ariaLabel: string;
}) {
  const [value, setValue] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastAppliedSeqRef = useRef<number | undefined>(undefined);
  const pendingSelectionRestoreRef = useRef<SessionMonacoSelectionRestore | null>(null);

  useEffect(() => {
    if (!readOnly) return;
    setValue(text);
  }, [readOnly, text]);

  useEffect(() => {
    if (!externalTextUpdate || lastAppliedSeqRef.current === externalTextUpdate.seq) return;
    lastAppliedSeqRef.current = externalTextUpdate.seq;
    const result = value === externalTextUpdate.text ? 'no-op' : 'applied';
    if (result === 'applied') {
      pendingSelectionRestoreRef.current = externalTextUpdate.restoreSelection ?? null;
      setValue(externalTextUpdate.text);
    }
    onExternalTextUpdateApplied?.(result);
  }, [externalTextUpdate, onExternalTextUpdateApplied, value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const currentValue = textarea.value;
    const lineCount = currentValue.split('\n').length;
    const range = normalizeSessionMonacoSelectedLines(selectedLines, lineCount);
    if (!range) return;
    const lineStarts = [0];
    for (let index = 0; index < currentValue.length; index += 1) {
      if (currentValue[index] === '\n') lineStarts.push(index + 1);
    }
    const startOffset = lineStarts[range.startLineNumber - 1] ?? 0;
    const nextLineOffset = lineStarts[range.endLineNumber];
    const endOffset =
      nextLineOffset === undefined
        ? currentValue.length
        : Math.max(startOffset, nextLineOffset - 1);
    textarea.setSelectionRange(startOffset, endOffset);
    textarea.scrollTop = Math.max(0, range.startLineNumber - 1) * 20;
  }, [selectedLines]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const restore = pendingSelectionRestoreRef.current;
    if (!textarea || !restore) return;
    pendingSelectionRestoreRef.current = null;
    const anchor = Math.min(value.length, Math.max(0, restore.anchorOffset));
    const head = Math.min(value.length, Math.max(0, restore.headOffset));
    textarea.setSelectionRange(
      Math.min(anchor, head),
      Math.max(anchor, head),
      anchor > head ? 'backward' : 'forward'
    );
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      readOnly={readOnly}
      wrap={wordWrap ? 'soft' : 'off'}
      spellCheck={false}
      aria-label={ariaLabel}
      data-native-selection-allow
      className="h-full min-h-[240px] w-full resize-none overflow-auto border-0 bg-background p-3 font-mono text-xs leading-5 text-foreground outline-none"
      onChange={(event) => {
        const nextValue = event.currentTarget.value;
        setValue(nextValue);
        onContentChange?.(nextValue);
      }}
      onSelect={(event) => {
        const textarea = event.currentTarget;
        const selectionStart = textarea.selectionStart;
        const selectionEnd = textarea.selectionEnd;
        const backwards = textarea.selectionDirection === 'backward';
        onSelectionChange?.({
          anchorOffset: backwards ? selectionEnd : selectionStart,
          headOffset: backwards ? selectionStart : selectionEnd,
          isEmpty: selectionStart === selectionEnd,
        });
      }}
    />
  );
}

// Eye-icon preview toggle for text files that also have a rendered preview
// (SVG, Markdown). Click commits the render mode; hover only shows a tooltip
// (no transient markdown/SVG render on hover).
function FilePreviewToggle({
  active,
  onToggle,
  showLabel,
  hideLabel,
}: {
  readonly active: boolean;
  readonly onToggle: () => void;
  readonly showLabel: string;
  readonly hideLabel: string;
}): ReactNode {
  const Icon = active ? EyeClosed : Eye;
  const label = active ? hideLabel : showLabel;
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          onClick={onToggle}
          aria-label={label}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground',
            active ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {/* lucide's open Eye packs the iris + almond into 14px, so at stroke-width
              2 it reads ~26% denser than the neighbouring Search glyph and looks
              darker at the same color. Thin it to 1.5 to match Search's optical
              weight (measured ink coverage 20.2% vs 20.9%). The closed Eye has no
              iris (already lighter) and is shown alone in the active color, so it
              keeps the default weight. */}
          <Icon className="h-3.5 w-3.5" strokeWidth={active ? 2 : 1.5} aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

type SessionFileContentViewTranslation = (
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>
) => string;

type RealtimeStatusItem = {
  readonly key: string;
  readonly label: string;
  readonly title?: string;
  readonly icon?: 'cloud-offline';
  readonly iconOnly?: boolean;
  readonly tone: 'positive' | 'muted' | 'warning' | 'danger';
};

export function SessionFileRealtimeStatusBar({
  saveStatus,
  liveStatus,
  showSaveStatus,
  machineOffline,
  t,
}: {
  readonly saveStatus?: SessionFileSaveStatus;
  readonly liveStatus?: SessionFileLiveSyncStatus;
  readonly showSaveStatus?: boolean;
  readonly machineOffline?: boolean;
  readonly t: SessionFileContentViewTranslation;
}): ReactNode {
  const machineItem = machineOffline === true ? machineOfflineStatusItem(t) : null;
  const saveItem = showSaveStatus === true && saveStatus ? saveStatusItem(saveStatus, t) : null;
  const liveItem = showSaveStatus === true && liveStatus ? liveStatusItem(liveStatus, t) : null;
  const items = [machineItem, saveItem, liveItem].filter(
    (item): item is RealtimeStatusItem => item !== null
  );

  if (items.length === 0) return null;

  return (
    <div
      data-testid="session-file-realtime-status-bar"
      className="flex h-6 min-h-6 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-t border-border/50 bg-background px-2 text-[11px] leading-none text-muted-foreground"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        {items.map((item, index) => (
          <span key={item.key} className="flex min-w-0 shrink-0 items-center gap-1">
            {index > 0 ? <span className="mr-0.5 text-muted-foreground/55">·</span> : null}
            {item.icon === 'cloud-offline' ? (
              <FamiconsCloudOfflineOutline
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : (
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  realtimeStatusDotClass(item.tone)
                )}
              />
            )}
            <span
              className={cn(
                item.iconOnly === true ? 'sr-only' : 'truncate',
                item.tone === 'danger'
                  ? 'text-destructive'
                  : item.tone === 'warning'
                    ? 'text-amber-700 dark:text-amber-300'
                    : item.tone === 'positive'
                      ? 'text-foreground'
                      : ''
              )}
              title={item.title ?? item.label}
            >
              {item.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function machineOfflineStatusItem(t: SessionFileContentViewTranslation): RealtimeStatusItem {
  return {
    key: 'machine-offline',
    label: t('sessions.offline', 'Offline'),
    title: t('sessions.machineOffline', 'Machine is offline'),
    icon: 'cloud-offline',
    iconOnly: true,
    tone: 'muted',
  };
}

function saveStatusItem(
  status: SessionFileSaveStatus,
  t: SessionFileContentViewTranslation
): RealtimeStatusItem | null {
  switch (status.kind) {
    case 'idle':
      // A freshly opened file has never been saved — show nothing rather
      // than a misleading "Saved". Mirrors liveStatusItem's idle handling.
      return null;
    case 'saved':
      return {
        key: 'save',
        label: t('sessions.fileSave.compactSaved', 'Saved'),
        tone: 'positive',
      };
    case 'pending':
      return {
        key: 'save',
        label: t('sessions.fileSave.compactPending', 'Unsaved'),
        tone: 'warning',
      };
    case 'saving':
      return {
        key: 'save',
        label: t('sessions.fileSave.compactSaving', 'Saving'),
        tone: 'muted',
      };
    case 'error':
      return {
        key: 'save',
        label: t('sessions.fileSave.compactError', 'Save failed'),
        title: `${t('sessions.fileSave.compactError', 'Save failed')}: ${status.message}`,
        tone: 'danger',
      };
    case 'conflict_pending':
      return {
        key: 'save',
        label: t('sessions.fileSave.compactConflictPending', 'External change detected'),
        ...(status.message === undefined ? {} : { title: status.message }),
        tone: 'warning',
      };
    case 'conflict':
      return {
        key: 'save',
        label: t('sessions.fileSave.compactConflict', 'Save conflict'),
        tone: 'warning',
      };
  }
  return assertNever(status);
}

function liveStatusItem(
  status: SessionFileLiveSyncStatus,
  t: SessionFileContentViewTranslation
): RealtimeStatusItem | null {
  switch (status.kind) {
    case 'idle':
    case 'synced':
      return null;
    case 'pending':
    case 'syncing':
      return {
        key: 'live-sync',
        label: t('sessions.fileLiveSync.compactSyncing', 'Syncing live'),
        tone: 'muted',
      };
    case 'delayed':
      return {
        key: 'live-sync',
        label: t('sessions.fileLiveSync.compactDelayed', 'Live sync delayed'),
        title: status.message,
        tone: 'warning',
      };
  }
  return assertNever(status);
}

function realtimeStatusDotClass(tone: RealtimeStatusItem['tone']): string {
  switch (tone) {
    case 'positive':
      return 'bg-emerald-500';
    case 'muted':
      return 'bg-muted-foreground/50';
    case 'warning':
      return 'bg-amber-500';
    case 'danger':
      return 'bg-destructive';
  }
  return assertNever(tone);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session file content view value: ${String(value)}`);
}

function createSelectedLines(
  startLine: number | undefined,
  endLine: number | undefined,
  _focusRequestSeq: number | undefined
): SessionMonacoSelectedLines {
  return startLine == null
    ? null
    : {
        start: startLine,
        end: endLine ?? startLine,
      };
}

function createStableProviderEditorSelection(input: {
  readonly fileId: string;
  readonly selection: ProviderEditorSelectionState;
}): StableProviderEditorSelection {
  return {
    fileId: input.fileId,
    anchorOffset: input.selection.anchorOffset,
    headOffset: input.selection.headOffset,
  };
}

function resolveStableProviderEditorSelection(input: {
  readonly fileId: string | null;
  readonly selection: StableProviderEditorSelection | null;
}): SessionMonacoSelectionRestore | undefined {
  if (!input.fileId || !input.selection || input.selection.fileId !== input.fileId) {
    return undefined;
  }
  return {
    anchorOffset: input.selection.anchorOffset,
    headOffset: input.selection.headOffset,
  };
}

// "Overwrite disk" is destructive: it discards whatever changed on
// disk under our edits, which may include another peer's work. The
// action row therefore puts the overwrite path behind an inline
// confirm step, while "Discard my edits" and "Insert conflict markers"
// stay one-click because their loss model is confined to the local user.
export function SessionFileConflictActionRow({
  onResolveConflict,
  t,
}: {
  readonly onResolveConflict: (
    resolution: 'override' | 'discard' | 'load_with_conflicts'
  ) => Promise<void>;
  readonly t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string;
}): ReactNode {
  const [pendingOverride, setPendingOverride] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-300">
      <span className="text-muted-foreground">
        {pendingOverride
          ? t(
              'sessions.fileSave.conflictOverrideWarn',
              'Overwriting disk discards changes made by others or by the agent. Continue?'
            )
          : t(
              'sessions.fileSave.conflictDetail',
              'The file changed on disk while you were editing. Choose how to reconcile.'
            )}
      </span>
      <span className="ml-auto flex gap-1.5">
        {pendingOverride ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setPendingOverride(false)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                setPendingOverride(false);
                void onResolveConflict('override');
              }}
            >
              {t('sessions.fileSave.conflictOverrideConfirm', 'Confirm: overwrite disk')}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              title={t(
                'sessions.fileSave.conflictDiscardHint',
                'Throw away your local edits and reload from disk.'
              )}
              onClick={() => void onResolveConflict('discard')}
            >
              {t('sessions.fileSave.conflictDiscard', 'Discard my edits')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              title={t(
                'sessions.fileSave.conflictMarkersHint',
                'Reload with <<<<<<< / >>>>>>> conflict markers so you can resolve by hand.'
              )}
              onClick={() => void onResolveConflict('load_with_conflicts')}
            >
              {t('sessions.fileSave.conflictMarkers', 'Insert conflict markers')}
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-6 px-2 text-[11px]"
              title={t(
                'sessions.fileSave.conflictOverrideHint',
                'Replace the disk version with your edits. Concurrent changes will be lost.'
              )}
              onClick={() => setPendingOverride(true)}
            >
              {t('sessions.fileSave.conflictOverride', 'Overwrite disk')}
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

function SessionFileLspPanel({
  state,
  t,
  onDismiss,
  currentFileId,
  onOpenLocation,
}: {
  readonly state: CodeCollabLspState;
  readonly t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string;
  readonly onDismiss: () => void;
  readonly currentFileId?: string | null;
  // Optional cross-file opener. When wired, every result becomes a
  // clickable button that routes through the session's viewer-tab
  // manager. Cross-file results are highlighted so the user sees the
  // affordance is non-trivial (it'll open a new tab, not just scroll).
  readonly onOpenLocation?: (target: {
    readonly filePath: string;
    readonly fileId?: string;
    readonly line?: number;
    readonly character?: number;
  }) => void;
}): ReactNode {
  if (state.kind === 'idle') return null;
  const actionLabel =
    state.action === 'definition'
      ? t('sessions.lsp.definitionTitle', 'Go to Definition')
      : t('sessions.lsp.referencesTitle', 'Find References');
  return (
    <div className="flex flex-col gap-1 border-t border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{actionLabel}</span>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('sessions.lsp.dismiss', 'Dismiss')}
        </Button>
      </div>
      {state.kind === 'pending' ? (
        <span className="text-muted-foreground">
          {t('sessions.lsp.pending', 'Querying host language service…')}
        </span>
      ) : null}
      {state.kind === 'error' ? (
        <span className="text-destructive">
          {t('sessions.lsp.error', 'LSP request failed')}: {state.message}
        </span>
      ) : null}
      {state.kind === 'result' && state.result.status === 'unsupported' ? (
        <span className="text-muted-foreground">
          {t('sessions.lsp.unsupported', 'Host language service does not support this file')}:{' '}
          {state.result.message}
        </span>
      ) : null}
      {state.kind === 'result' && state.result.status === 'ready' ? (
        state.result.locations.length === 0 ? (
          <span className="text-muted-foreground">
            {t('sessions.lsp.empty', 'No locations found')}
          </span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {state.result.locations.map((location, index) => {
              const isCrossFile =
                currentFileId !== undefined &&
                currentFileId !== null &&
                location.fileId !== currentFileId;
              const titleHint = `${location.path}:${location.range.start.line + 1}:${
                location.range.start.character + 1
              }${isCrossFile ? ` — ${t('sessions.lsp.crossFileHint', 'opens in this tab')}` : ''}`;
              if (!onOpenLocation) {
                return (
                  <li
                    key={`${location.fileId}:${location.range.start.line}:${location.range.start.character}:${index}`}
                    className="truncate text-muted-foreground"
                    title={titleHint}
                  >
                    <span className="text-foreground">{location.path}</span>
                    <span>
                      :{location.range.start.line + 1}:{location.range.start.character + 1}
                    </span>
                  </li>
                );
              }
              return (
                <li
                  key={`${location.fileId}:${location.range.start.line}:${location.range.start.character}:${index}`}
                  className="truncate"
                >
                  <button
                    type="button"
                    title={titleHint}
                    onClick={() =>
                      onOpenLocation({
                        filePath: location.path,
                        fileId: location.fileId,
                        line: location.range.start.line,
                        character: location.range.start.character,
                      })
                    }
                    className={cn(
                      'w-full truncate text-left text-muted-foreground hover:text-foreground hover:underline',
                      isCrossFile && 'font-medium text-foreground'
                    )}
                  >
                    <span className="text-foreground">{location.path}</span>
                    <span>
                      :{location.range.start.line + 1}:{location.range.start.character + 1}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}

function LazyProviderTextMonacoViewer(props: SessionTextMonacoViewerProps) {
  return <LazyTextMonacoViewer {...props} />;
}

function LazyTextMonacoViewer(props: SessionTextMonacoViewerProps) {
  return <SessionMonacoTextViewer {...props} />;
}

type SessionTextMonacoViewerProps = {
  readonly text: string;
  readonly language: string;
  readonly selectedLines: SessionMonacoSelectedLines;
  readonly resolvedTheme: 'light' | 'dark';
  readonly vscodeTheme: import('@/lib/vscode-theme').LodyResolvedVSCodeTheme | null;
  readonly readOnly: boolean;
  readonly onContentChange?: (text: string) => void;
  readonly onSelectionChange?: (state: {
    readonly anchorOffset: number;
    readonly headOffset: number;
    readonly isEmpty: boolean;
  }) => void;
  readonly onGoToDefinition?: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly onFindReferences?: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly externalTextUpdate?: SessionMonacoExternalTextUpdate;
  readonly onExternalTextUpdateApplied?: (result: 'applied' | 'no-op') => void;
  readonly findRequestSeq?: number;
  readonly modelUri?: import('monaco-editor/esm/vs/editor/editor.api.js').Uri;
};
