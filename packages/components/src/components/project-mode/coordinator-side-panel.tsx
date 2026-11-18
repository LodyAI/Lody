import {
  getSessionRoomId,
  parseBrowserAddress,
  resolveProjectGitHubRepo,
  type ElectronPublicBrowserState,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { atom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { sessionMetaAtomFamily } from '@/atoms/doc-meta';
import { parseGitHubReferenceUrl } from '@/components/ai-gui/github-reference-link';
import { PublicBrowserSurface } from '@/components/sessions/public-browser-surface';
import { SessionBrowserPanelView } from '@/components/sessions/session-browser-panel-view';
import { SessionFileContentView } from '@/components/sessions/session-file-content-view';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import { useCodeCollabSessionFileProvider } from '@/hooks/use-code-collab-session-file-provider';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import { getPublicBrowserBridge } from '@/lib/electron-ipc-client';

/**
 * Project mode keeps the coordinator's board as a resident tab of the session's
 * right side panel. It is never persisted: the stored side-panel state names
 * only the shared fixed panels, so the board is re-selected on entry instead.
 */
export const PROJECT_BOARD_PANEL_TAB_ID = 'project-board';

/**
 * Conversations opened from the board into the coordinator's right panel. They
 * are independent Sessions (own machine, workspace and lifecycle), shown in the
 * panel the way a Side Chat is; closing the tab never deletes them.
 */
export function usePanelSessionMetas(sessionIds: readonly SessionId[]): SessionMeta[] {
  const key = sessionIds.join('\n');
  const metasAtom = useMemo(() => {
    const ids = key ? (key.split('\n') as SessionId[]) : [];
    let previous: SessionMeta[] = [];
    return atom((get) => {
      const next = ids.flatMap((id) => {
        const meta = get(sessionMetaAtomFamily(getSessionRoomId(id)));
        return meta ? [meta] : [];
      });
      if (next.length === previous.length && next.every((meta, i) => meta === previous[i])) {
        return previous;
      }
      previous = next;
      return next;
    });
  }, [key]);
  return useAtomValue(metasAtom);
}

/**
 * A file tab opened from a conversation hosted in the panel. It reads that
 * conversation's own workspace, so a child running in another worktree or on
 * another machine never shows the coordinator's copy of the path.
 */
export function OwnedSessionFileViewer({
  ownerSessionId,
  filePath,
  startLine,
  endLine,
  focusRequestSeq,
  htmlPreviewRequestSeq,
  active,
  className,
}: {
  ownerSessionId: SessionId;
  filePath: string;
  startLine?: number;
  endLine?: number;
  focusRequestSeq?: number;
  htmlPreviewRequestSeq?: number;
  active: boolean;
  className?: string;
}) {
  const session = useAtomValue(sessionMetaAtomFamily(getSessionRoomId(ownerSessionId)));
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const requestedRole = useCodeCollabRequestedRole();
  const workspaceId = resolveEffectiveCodeCollabWorkspaceId({
    currentWorkspaceId,
    runtimeWorkspaceId: runtime?.workspaceId,
  });
  const files = useCodeCollabSessionFileProvider({
    workspaceId,
    sessionId: ownerSessionId,
    enabled: Boolean(session && workspaceId),
    requestedRole,
    machineId: session?.machineId,
    requestedByUserId: user?.id ?? session?.userId,
    githubRepoFullName:
      (resolveProjectGitHubRepo(session?.project) ?? session?.repoFullName)?.trim() ?? null,
    debugLabel: 'project-mode:owned-file',
  });
  if (!session) return null;
  return (
    <SessionFileContentView
      key={`${ownerSessionId}:${filePath}`}
      sessionId={ownerSessionId}
      session={session}
      filePath={filePath}
      startLine={startLine}
      endLine={endLine}
      focusRequestSeq={focusRequestSeq}
      htmlPreviewRequestSeq={htmlPreviewRequestSeq}
      className={className}
      active={active}
      fileProvider={files.provider}
      fileProviderPending={!files.provider && files.status === 'checking'}
      {...(files.role === undefined ? {} : { fileProviderRole: files.role })}
    />
  );
}

const noop = () => {};

export function formatExternalUrlTabLabel(logicalUrl: string, linkLabel?: string): string {
  const githubRef = parseGitHubReferenceUrl(logicalUrl);
  if (githubRef) {
    return `${githubRef.repo} #${githubRef.number}`;
  }
  const trimmedLabel = linkLabel?.trim();
  if (trimmedLabel && !/^https?:\/\//i.test(trimmedLabel) && !/^www\./i.test(trimmedLabel)) {
    return trimmedLabel;
  }
  try {
    const parsed = new URL(logicalUrl);
    const cleanPath = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (/^(?:www\.)?github\.com$/i.test(parsed.hostname) && cleanPath) {
      return cleanPath;
    }
    return cleanPath ? `${parsed.hostname}/${cleanPath}` : parsed.hostname;
  } catch {
    return logicalUrl;
  }
}

/**
 * External HTTP(S) link opened from the coordinator conversation as an
 * independent right-panel tab using Electron's sandboxed PublicBrowserSurface.
 */
export function OwnedUrlViewer({
  tabId,
  initialUrl,
  active,
  className,
  onTitleChange,
}: {
  tabId: string;
  initialUrl: string;
  active: boolean;
  className?: string;
  onTitleChange?: (title: string) => void;
}) {
  const { t } = useTranslation();
  const browserId = useMemo(
    () => `coordinator-${tabId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96)}`,
    [tabId]
  );
  const seqRef = useRef(1);
  const [address, setAddress] = useState(initialUrl);
  const [committedUrl, setCommittedUrl] = useState(initialUrl);
  const [publicState, setPublicState] = useState<ElectronPublicBrowserState | null>(null);
  const [navigationRequest, setNavigationRequest] = useState<{ id: number; url: string } | null>({
    id: 1,
    url: initialUrl,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      void getPublicBrowserBridge()
        ?.destroy(browserId)
        .catch(() => undefined);
    },
    [browserId]
  );

  const handleStateChange = useCallback(
    (state: ElectronPublicBrowserState) => {
      setPublicState(state);
      if (state.url) {
        setCommittedUrl(state.url);
        setAddress(state.url);
      }
      const nextTitle = state.title?.trim();
      if (nextTitle) {
        onTitleChange?.(nextTitle);
      }
    },
    [onTitleChange]
  );

  const handleNavigate = useCallback(() => {
    try {
      const parsed = parseBrowserAddress(address);
      if (parsed.engine !== 'public-web') {
        setError(t('sessions.browser.errors.invalidAddress', 'Enter a valid HTTP(S) URL.'));
        return;
      }
      setError(null);
      setAddress(parsed.logicalUrl);
      setCommittedUrl(parsed.logicalUrl);
      setNavigationRequest({ id: ++seqRef.current, url: parsed.logicalUrl });
    } catch (navigationError) {
      setError(navigationError instanceof Error ? navigationError.message : String(navigationError));
    }
  }, [address, t]);

  const handleNavigationRequestConsumed = useCallback((consumed: { id: number; url: string }) => {
    setNavigationRequest((current) => (current?.id === consumed.id ? null : current));
  }, []);

  return (
    <SessionBrowserPanelView
      className={className}
      error={error}
      onDismissError={() => setError(null)}
      toolbar={{
        address,
        canGoBack: publicState?.canGoBack ?? false,
        canGoForward: publicState?.canGoForward ?? false,
        loading: publicState?.phase === 'loading',
        annotationEnabled: false,
        annotationAvailable: false,
        sharing: false,
        shareAvailable: false,
        hasShareUrl: false,
        busy: false,
        onAddressChange: setAddress,
        onRestoreAddress: () => setAddress(committedUrl),
        onNavigate: handleNavigate,
        onBack: () => void getPublicBrowserBridge()?.back(browserId),
        onForward: () => void getPublicBrowserBridge()?.forward(browserId),
        onReload: () => {
          setError(null);
          if (publicState?.url) {
            void getPublicBrowserBridge()?.reload(browserId);
          } else {
            setNavigationRequest({ id: ++seqRef.current, url: committedUrl });
          }
        },
        onStop: () => void getPublicBrowserBridge()?.stop(browserId),
        onToggleAnnotation: noop,
        onShare: noop,
        onStopSharing: noop,
      }}
    >
      <PublicBrowserSurface
        browserId={browserId}
        navigationRequest={navigationRequest}
        active={active}
        onStateChange={handleStateChange}
        onNavigationRequestConsumed={handleNavigationRequestConsumed}
      />
    </SessionBrowserPanelView>
  );
}
