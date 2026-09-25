import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  BrowserAddressError,
  formatPreviewTargetUrl,
  getServerNow,
  parseBrowserAddress,
  type BrowserAddress,
  type ElectronPublicBrowserState,
  type ManagedBrowserCommand,
  type ManagedBrowserStateMessage,
  type PreviewConnection,
  type PreviewTarget,
  type PreviewTargetApproval,
  type SessionMeta,
  type SessionPreviewDocState,
  type SessionPreviewEndpoint,
  type VisualAnnotationReferencePayload,
} from '@lody/shared';

import { activeWorkspaceRuntimeAtom, userAtom } from '@/atoms';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { machineOnlineStatusAtomFamily } from '@/atoms/presence';
import { toast } from '@/lib/toast';
import { writeTextToClipboard } from '@/lib/clipboard';
import { isElectronRenderer } from '@/lib/electron';
import { getPublicBrowserBridge } from '@/lib/electron-ipc-client';
import { useSessionDoc } from '@/hooks/use-session-doc';
import { hasUsableManagedPreviewUrl } from '@/lib/managed-preview-connection';
import { buildManagedViewerUrl, samePreviewTargetOrigin } from '@/lib/session-browser-url';
import { ManagedPreviewSurface } from './managed-preview-surface';
import { PublicBrowserSurface } from './public-browser-surface';
import {
  readSessionBrowserResumeState,
  rememberSessionBrowserResumeState,
  type SessionBrowserNavigationHistory,
} from './session-browser-resume-state';
import { clearManagedPreviewFrame } from './managed-preview-frame-cache';
import { SessionBrowserPanelView, type ManagedNavigationPhase } from './session-browser-panel-view';

type SessionBrowserPanelProps = {
  session: SessionMeta;
  active?: boolean;
  className?: string;
  leadingSlot?: ReactNode;
  candidateNavigationRequestId?: number;
  onCandidateNavigationRequestHandled?: (requestId: number) => void;
  visualAnnotationReferenceKeys?: readonly string[];
  onAddVisualAnnotationToChat?: (reference: VisualAnnotationReferencePayload) => boolean | void;
  onToggleVisualAnnotationInChat?: (reference: VisualAnnotationReferencePayload) => boolean | void;
};

type EffectivePreviewState = {
  connection?: PreviewConnection;
};

type PublicBrowserNavigationRequest = { id: number; url: string };

const approvalFor = (
  address: BrowserAddress & { engine: 'managed-preview'; target: PreviewTarget },
  userId: string,
  source: PreviewTargetApproval['source']
): PreviewTargetApproval => ({
  source,
  targetClass: 'loopback',
  target: address.target,
  confirmedByUserId: userId,
  confirmedAt: getServerNow(),
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function SessionBrowserPanel(props: SessionBrowserPanelProps) {
  return <SessionBrowserPanelController key={props.session.id} {...props} />;
}

function SessionBrowserPanelController({
  session,
  active = true,
  className,
  leadingSlot,
  candidateNavigationRequestId = 0,
  onCandidateNavigationRequestHandled,
  visualAnnotationReferenceKeys,
  onAddVisualAnnotationToChat,
  onToggleVisualAnnotationInChat,
}: SessionBrowserPanelProps) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const sessionMachine = useAtomValue(getMachineMetaByIdAtomFamily(session.machineId));
  const machineOnline = useAtomValue(machineOnlineStatusAtomFamily(session.machineId));
  const sessionDoc = useSessionDoc(session.id);
  const [remoteConnection, setRemoteConnection] = useState<PreviewConnection | undefined>();
  const [checkingPreview, setCheckingPreview] = useState(true);
  const [previewStatusError, setPreviewStatusError] = useState<string | null>(null);
  const previewObservationEpoch = useRef(0);
  const previewControlInFlight = useRef(false);
  const effectivePreview: EffectivePreviewState = { connection: remoteConnection };
  const suggestedAddress = useMemo(() => {
    const preview = sessionDoc.doc.preview as SessionPreviewDocState | undefined;
    const candidate = preview?.candidate;
    return candidate?.status === 'available' && candidate.target
      ? formatPreviewTargetUrl(candidate.target)
      : '';
  }, [sessionDoc.doc.preview]);
  // Session meta carries only the candidate STATUS; its target lives in the
  // session doc `preview` state. The two planes sync independently, so a click
  // can land after the status is visible but before the doc write arrives.
  const metaCandidateAvailable = session.previewCandidate?.status === 'available';

  const [address, setAddress] = useState(suggestedAddress);
  const [currentAddress, setCurrentAddress] = useState<BrowserAddress | null>(null);
  const currentAddressRef = useRef(currentAddress);
  currentAddressRef.current = currentAddress;
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [localEndpoint, setLocalEndpoint] = useState<SessionPreviewEndpoint | null>(null);
  const localEndpointRef = useRef<SessionPreviewEndpoint | null>(null);
  const [history, setHistory] = useState<SessionBrowserNavigationHistory>({
    entries: [],
    index: -1,
  });
  const [publicState, setPublicState] = useState<ElectronPublicBrowserState | null>(null);
  // Native state may change the current address after a redirect or history
  // movement. Keep the explicit renderer intent separate so that observation
  // cannot be fed back into WebContentsView.loadURL.
  const [publicNavigationRequest, setPublicNavigationRequest] =
    useState<PublicBrowserNavigationRequest | null>(null);
  const [annotationEnabled, setAnnotationEnabled] = useState(false);
  const [annotationAvailable, setAnnotationAvailable] = useState(false);
  const [managedLoading, setManagedLoading] = useState(false);
  const [managedState, setManagedState] = useState<ManagedBrowserStateMessage['payload'] | null>(
    null
  );
  const [managedCommand, setManagedCommand] = useState<{
    id: number;
    action: ManagedBrowserCommand;
  }>();
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [managedNavigationPhase, setManagedNavigationPhase] =
    useState<ManagedNavigationPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [machinePlane, setMachinePlane] = useState<'local' | 'cloud' | null>(null);
  const [resumeAddress, setResumeAddress] = useState<BrowserAddress | null>(null);
  const navigationSequenceRef = useRef(0);
  const publicNavigationSequenceRef = useRef(0);
  const restoreAttemptKeyRef = useRef<string | null>(null);
  const handledCandidateNavigationRequestRef = useRef(0);

  const isLocalDesktopSession = isElectronRenderer() && machinePlane === 'local';
  const foregroundEndpointRef = useRef<string | undefined>(undefined);
  foregroundEndpointRef.current =
    !isLocalDesktopSession && currentAddress?.engine === 'managed-preview' && viewerUrl
      ? remoteConnection?.endpointId
      : undefined;
  const previewDocumentRevision = (sessionDoc.doc.preview as SessionPreviewDocState | undefined)
    ?.connection?.updatedAt;
  // Persisted targets are navigation hints, never evidence that a capability is still live.
  const persistedPreviewTarget = (sessionDoc.doc.preview as SessionPreviewDocState | undefined)
    ?.connection?.target;
  const statusTimeoutMessage = t(
    'sessions.browser.errors.timeout',
    'Remote preview request timed out.'
  );

  useEffect(() => {
    if (!active || !runtime || !user?.id) return undefined;
    let disposed = false;
    let requestSequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (renew: boolean) => {
      if (disposed || document.hidden) return;
      if (previewControlInFlight.current) {
        timer = setTimeout(() => void refresh(true), 60_000);
        return;
      }
      const sequence = ++requestSequence;
      const epoch = previewObservationEpoch.current;
      if (!renew) setCheckingPreview(true);
      try {
        const response = await runtime.requestSessionPreviewStatus(
          session.machineId,
          session.id,
          user.id,
          {
            renewEndpointId: renew ? foregroundEndpointRef.current : undefined,
          }
        );
        if (disposed || sequence !== requestSequence || epoch !== previewObservationEpoch.current)
          return;
        if (!response?.success) throw new Error(response?.message ?? statusTimeoutMessage);
        setRemoteConnection(response.connection);
        setPreviewStatusError(null);
        const current = currentAddressRef.current;
        if (!localEndpointRef.current && current?.engine === 'managed-preview') {
          setViewerUrl(
            current.target &&
              hasUsableManagedPreviewUrl(response.connection) &&
              samePreviewTargetOrigin(response.connection.target, current.target)
              ? buildManagedViewerUrl(response.connection.publicUrl, current.target)
              : null
          );
        }
      } catch (statusError) {
        if (
          !disposed &&
          sequence === requestSequence &&
          epoch === previewObservationEpoch.current
        ) {
          setPreviewStatusError(errorMessage(statusError));
          if (!localEndpointRef.current) setViewerUrl(null);
        }
      } finally {
        if (!disposed && sequence === requestSequence) {
          setCheckingPreview(false);
          if (!document.hidden) timer = setTimeout(() => void refresh(true), 60_000);
        }
      }
    };
    const visibilityChanged = () => {
      clearTimeout(timer);
      requestSequence += 1;
      if (!document.hidden) void refresh(false);
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void refresh(false);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [
    active,
    runtime,
    session.id,
    session.machineId,
    user?.id,
    previewDocumentRevision,
    statusTimeoutMessage,
  ]);
  const activeShareUrl = useMemo(() => {
    const connection = effectivePreview.connection;
    if (
      currentAddress?.engine !== 'managed-preview' ||
      !currentAddress.target ||
      !samePreviewTargetOrigin(connection?.target, currentAddress.target) ||
      !hasUsableManagedPreviewUrl(connection)
    ) {
      return undefined;
    }
    return connection.publicUrl;
  }, [currentAddress, effectivePreview.connection]);

  const releaseLocalEndpoint = useCallback(async () => {
    const endpoint = localEndpointRef.current;
    localEndpointRef.current = null;
    setLocalEndpoint(null);
    if (!endpoint) return;
    if (!runtime) {
      console.error('Cannot release managed preview endpoint because the runtime is unavailable', {
        endpointId: endpoint.endpointId,
        sessionId: session.id,
      });
      return;
    }
    const response = await runtime.requestSessionPreviewEndpointRelease(
      session.machineId,
      session.id,
      endpoint.endpointId
    );
    if (!response?.success) {
      console.error('Failed to release managed preview endpoint', {
        endpointId: endpoint.endpointId,
        sessionId: session.id,
        response,
      });
    }
  }, [runtime, session.id, session.machineId]);

  // A cached frame keeps its viewer URL — and the capability token in it — alive
  // in this renderer. Once an address is open without a managed viewer URL, that
  // capability is no longer the session's current one, so the frame must go.
  // Derived from state rather than cleared at each release site, so a remote
  // tunnel (which has no local endpoint to release) is covered too.
  useEffect(() => {
    if (!currentAddress || viewerUrl) return;
    clearManagedPreviewFrame(session.id);
  }, [currentAddress, session.id, viewerUrl]);

  useEffect(() => {
    const resumeState = readSessionBrowserResumeState(session.id);
    navigationSequenceRef.current += 1;
    localEndpointRef.current = null;
    restoreAttemptKeyRef.current = null;
    handledCandidateNavigationRequestRef.current = 0;
    setAddress(resumeState?.currentAddress.logicalUrl ?? '');
    setCurrentAddress(null);
    setViewerUrl(null);
    setLocalEndpoint(null);
    setHistory(resumeState?.history ?? { entries: [], index: -1 });
    setPublicState(null);
    setPublicNavigationRequest(null);
    setManagedState(null);
    setManagedCommand(undefined);
    setAnnotationEnabled(false);
    setAnnotationAvailable(false);
    setBusy(false);
    setSharing(false);
    setManagedNavigationPhase(null);
    setError(null);
    setMachinePlane(null);
    setResumeAddress(resumeState?.currentAddress ?? null);
  }, [session.id]);

  useEffect(() => {
    if (suggestedAddress && !address && !currentAddress) setAddress(suggestedAddress);
  }, [address, currentAddress, suggestedAddress]);

  useEffect(() => {
    if (!currentAddress) return;
    rememberSessionBrowserResumeState(session.id, { currentAddress, history });
  }, [currentAddress, history, session.id]);

  // Only Electron can host a local plane; every other renderer is cloud-only.
  const resolveMachinePlane = useCallback(
    async (workspaceRuntime: NonNullable<typeof runtime>): Promise<'local' | 'cloud'> =>
      isElectronRenderer()
        ? await workspaceRuntime.resolveMachineTargetPlane(session.machineId)
        : 'cloud',
    [session.machineId]
  );

  useEffect(() => {
    let cancelled = false;
    if (!runtime) {
      setMachinePlane(null);
      return undefined;
    }
    void resolveMachinePlane(runtime).then(
      (plane) => {
        if (!cancelled) setMachinePlane(plane);
      },
      () => {
        if (!cancelled) setMachinePlane(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [resolveMachinePlane, runtime]);

  const commitHistory = useCallback((logicalUrl: string, historyIndex?: number) => {
    setHistory((current) => {
      if (historyIndex !== undefined) return { ...current, index: historyIndex };
      if (current.entries[current.index] === logicalUrl) return current;
      if (current.index > 0 && current.entries[current.index - 1] === logicalUrl) {
        return { ...current, index: current.index - 1 };
      }
      if (
        current.index >= 0 &&
        current.index < current.entries.length - 1 &&
        current.entries[current.index + 1] === logicalUrl
      ) {
        return { ...current, index: current.index + 1 };
      }
      const entries = [...current.entries.slice(0, current.index + 1), logicalUrl].slice(-50);
      return { entries, index: entries.length - 1 };
    });
  }, []);

  const commitOpenedAddress = useCallback(
    (next: BrowserAddress, nextViewerUrl: string | null, historyIndex?: number) => {
      setCurrentAddress(next);
      setAddress(next.logicalUrl);
      setViewerUrl(nextViewerUrl);
      setAnnotationEnabled(false);
      setAnnotationAvailable(false);
      setManagedState(null);
      setError(null);
      commitHistory(next.logicalUrl, historyIndex);
    },
    [commitHistory]
  );

  const createRemotePreview = useCallback(
    async (
      next: BrowserAddress & { engine: 'managed-preview'; target: PreviewTarget },
      source: PreviewTargetApproval['source'],
      options: { historyIndex?: number; activateViewer?: boolean; restart?: boolean }
    ): Promise<{ publicUrl: string; viewerUrl: string } | null> => {
      if (!runtime || !user?.id) {
        setError(
          t(
            'sessions.browser.errors.runtimeUnavailable',
            'The session runtime is unavailable. Remote preview was not created.'
          )
        );
        return null;
      }
      previewObservationEpoch.current += 1;
      previewControlInFlight.current = true;
      setPreviewStatusError(null);
      let response;
      try {
        response = await runtime.requestSessionPreviewCreate(
          session.machineId,
          session.id,
          user.id,
          next.target,
          approvalFor(next, user.id, source),
          {
            restart: options.restart,
          }
        );
      } finally {
        previewControlInFlight.current = false;
        previewObservationEpoch.current += 1;
      }
      if (!response) {
        setError(t('sessions.browser.errors.timeout', 'Remote preview request timed out.'));
        return null;
      }
      if (!response.success) {
        setRemoteConnection(response.connection);
        setPreviewStatusError(
          response.message ??
            t('sessions.browser.errors.tunnelFailed', 'Remote preview could not be created.')
        );
        setError(
          response.message ??
            t('sessions.browser.errors.tunnelFailed', 'Remote preview could not be created.')
        );
        return null;
      }
      if (
        !hasUsableManagedPreviewUrl(response.connection) ||
        !samePreviewTargetOrigin(response.connection.target, next.target)
      ) {
        setError(
          t(
            'sessions.browser.errors.invalidTunnelResponse',
            'Remote preview returned no trusted viewer URL.'
          )
        );
        return null;
      }
      const nextViewerUrl = buildManagedViewerUrl(response.connection.publicUrl, next.target);
      setRemoteConnection(response.connection);
      if (options.activateViewer !== false) {
        commitOpenedAddress(next, nextViewerUrl, options.historyIndex);
      }
      return { publicUrl: response.connection.publicUrl, viewerUrl: nextViewerUrl };
    },
    [commitOpenedAddress, runtime, session.id, session.machineId, t, user?.id]
  );

  const openAddress = useCallback(
    async (
      next: BrowserAddress,
      options?: {
        approved?: boolean;
        historyIndex?: number;
        restore?: boolean;
        /** The destination came from page content, not from the person. */
        fromPageContent?: boolean;
      }
    ) => {
      const sequence = ++navigationSequenceRef.current;
      setError(null);
      // A page inside Managed Preview is served by the agent machine, so a navigation
      // request it posts up is agent-authored, not a user gesture. Public destinations
      // are ordinary external links, and loopback still lands in the managed branch
      // below where it needs its own approval — but a private-LAN address would open
      // silently in the user's own browser, on the user's own network, which no page
      // has any business asking for. Only the address bar can reach one.
      if (options?.fromPageContent && next.targetClass === 'private-lan') {
        setError(
          t(
            'sessions.browser.errors.pagePrivateNetworkBlocked',
            'The page asked to open a private network address. Only you can enter one, from the address bar.'
          )
        );
        return;
      }
      if (next.engine === 'public-web') {
        await releaseLocalEndpoint();
        if (sequence !== navigationSequenceRef.current) return;
        commitOpenedAddress(next, null, options?.historyIndex);
        setPublicNavigationRequest(
          options?.restore
            ? null
            : { id: ++publicNavigationSequenceRef.current, url: next.logicalUrl }
        );
        return;
      }
      if (!next.target) {
        setError('Managed preview address did not include a target.');
        return;
      }
      const managedAddress = next as BrowserAddress & {
        engine: 'managed-preview';
        target: PreviewTarget;
      };
      if (!runtime || !user?.id) {
        setError(
          t(
            'sessions.browser.errors.runtimeUnavailable',
            'The session runtime is unavailable. The page was not opened.'
          )
        );
        return;
      }
      setManagedNavigationPhase('resolving-machine');
      let resolvedPlane: 'local' | 'cloud';
      try {
        resolvedPlane = await resolveMachinePlane(runtime);
      } catch (routeError) {
        setError(
          t(
            'sessions.browser.errors.machineIdentityUnavailable',
            'The desktop client could not resolve the session machine route: {{error}}',
            { error: errorMessage(routeError) }
          )
        );
        setManagedNavigationPhase(null);
        return;
      }
      if (sequence !== navigationSequenceRef.current) return;
      setMachinePlane(resolvedPlane);
      const useLocalEndpoint = isElectronRenderer() && resolvedPlane === 'local';
      const connection = effectivePreview.connection;
      if (
        !useLocalEndpoint &&
        hasUsableManagedPreviewUrl(connection) &&
        samePreviewTargetOrigin(connection.target, managedAddress.target)
      ) {
        await releaseLocalEndpoint();
        if (sequence !== navigationSequenceRef.current) return;
        const nextViewerUrl = buildManagedViewerUrl(connection.publicUrl, managedAddress.target);
        commitOpenedAddress(managedAddress, nextViewerUrl, options?.historyIndex);
        setManagedNavigationPhase(null);
        return;
      }
      if (!useLocalEndpoint && options?.restore) {
        commitOpenedAddress(managedAddress, null, options?.historyIndex);
        setManagedNavigationPhase(null);
        return;
      }
      if (!useLocalEndpoint && !options?.approved) {
        setAddress(managedAddress.logicalUrl);
        setError(
          t(
            'sessions.browser.errors.pageTargetNeedsApproval',
            'The page requested another local service. Press Enter to authorize that address.'
          )
        );
        setManagedNavigationPhase(null);
        return;
      }

      setBusy(true);
      setManagedNavigationPhase(useLocalEndpoint ? 'opening-local' : 'creating-tunnel');
      try {
        if (!useLocalEndpoint) {
          await releaseLocalEndpoint();
          if (sequence !== navigationSequenceRef.current) return;
          commitOpenedAddress(managedAddress, null, options?.historyIndex);
          await createRemotePreview(managedAddress, 'browser_address', {
            historyIndex: options?.historyIndex,
          });
          return;
        }

        const previousEndpoint = localEndpointRef.current;
        const response = await runtime.requestSessionPreviewEndpointAcquire(
          session.machineId,
          session.id,
          user.id,
          managedAddress.target
        );
        if (sequence !== navigationSequenceRef.current) {
          if (response?.success && response.endpoint) {
            void runtime.requestSessionPreviewEndpointRelease(
              session.machineId,
              session.id,
              response.endpoint.endpointId
            );
          }
          return;
        }
        if (!response) {
          setError(t('sessions.browser.errors.timeout', 'Managed preview request timed out.'));
          return;
        }
        if (!response.success || !response.endpoint) {
          setError(
            response.message ??
              t('sessions.browser.errors.localPreviewFailed', 'Local preview could not be opened.')
          );
          return;
        }
        if (
          response.endpoint.kind !== 'local-proxy' ||
          !samePreviewTargetOrigin(response.endpoint.target, managedAddress.target) ||
          response.endpoint.capabilities.visualAnnotation !== true
        ) {
          setError(
            t(
              'sessions.browser.errors.invalidLocalEndpoint',
              'The local preview endpoint did not provide the required annotation capability.'
            )
          );
          void runtime.requestSessionPreviewEndpointRelease(
            session.machineId,
            session.id,
            response.endpoint.endpointId
          );
          return;
        }
        localEndpointRef.current = response.endpoint;
        setLocalEndpoint(response.endpoint);
        if (previousEndpoint && previousEndpoint.endpointId !== response.endpoint.endpointId) {
          void runtime.requestSessionPreviewEndpointRelease(
            session.machineId,
            session.id,
            previousEndpoint.endpointId
          );
        }
        commitOpenedAddress(managedAddress, response.endpoint.viewerUrl, options?.historyIndex);
      } catch (navigationError) {
        if (sequence === navigationSequenceRef.current) {
          setError(
            t('sessions.browser.errors.navigationFailed', 'Page could not be opened') +
              `: ${errorMessage(navigationError)}`
          );
        }
      } finally {
        if (sequence === navigationSequenceRef.current) {
          setManagedNavigationPhase(null);
          setBusy(false);
        }
      }
    },
    [
      commitOpenedAddress,
      createRemotePreview,
      effectivePreview.connection,
      releaseLocalEndpoint,
      resolveMachinePlane,
      runtime,
      session.id,
      session.machineId,
      t,
      user?.id,
    ]
  );

  useEffect(() => {
    if (
      !active ||
      (!isLocalDesktopSession && checkingPreview) ||
      currentAddress ||
      busy ||
      managedNavigationPhase !== null ||
      candidateNavigationRequestId > handledCandidateNavigationRequestRef.current
    ) {
      return;
    }

    let next = resumeAddress;
    let sourceKey = 'renderer';
    const connection = effectivePreview.connection;
    const target = connection?.target ?? persistedPreviewTarget;
    if (!next && target) {
      try {
        next = parseBrowserAddress(formatPreviewTargetUrl(target));
        sourceKey = connection?.endpointId ?? 'remote-preview';
      } catch (restoreError) {
        setError(errorMessage(restoreError));
        return;
      }
    }
    if (!next) return;

    const restoreKey = `${session.id}:${sourceKey}:${next.logicalUrl}`;
    if (restoreAttemptKeyRef.current === restoreKey) return;
    restoreAttemptKeyRef.current = restoreKey;
    setResumeAddress(null);
    void openAddress(next, { restore: true });
  }, [
    active,
    busy,
    checkingPreview,
    candidateNavigationRequestId,
    currentAddress,
    effectivePreview.connection,
    isLocalDesktopSession,
    managedNavigationPhase,
    openAddress,
    persistedPreviewTarget,
    resumeAddress,
    session.id,
  ]);

  useEffect(() => {
    if (
      !active ||
      candidateNavigationRequestId <= handledCandidateNavigationRequestRef.current ||
      busy ||
      managedNavigationPhase !== null
    ) {
      return;
    }
    if (!suggestedAddress) {
      // Hold the request while a reported candidate is still on its way: meta
      // knows one exists, the doc has not delivered its target yet. Consuming it
      // here would open an empty panel and drop the user's intent for good.
      if (sessionDoc.ready && !(metaCandidateAvailable && !sessionDoc.synced)) {
        handledCandidateNavigationRequestRef.current = candidateNavigationRequestId;
        onCandidateNavigationRequestHandled?.(candidateNavigationRequestId);
      }
      return;
    }

    handledCandidateNavigationRequestRef.current = candidateNavigationRequestId;
    onCandidateNavigationRequestHandled?.(candidateNavigationRequestId);
    try {
      const next = parseBrowserAddress(suggestedAddress);
      // Clicking Browser on an agent-reported candidate IS the approval for that
      // exact target, so a remote session opens straight through the tunnel it
      // needs instead of stopping on a confirmation. Only loopback candidates
      // qualify — the CLI accepts nothing else from an agent report, and a
      // private-LAN target still goes through the normal confirmation.
      void openAddress(next, { approved: next.targetClass === 'loopback' });
    } catch (candidateError) {
      setError(errorMessage(candidateError));
    }
  }, [
    active,
    busy,
    candidateNavigationRequestId,
    managedNavigationPhase,
    metaCandidateAvailable,
    openAddress,
    onCandidateNavigationRequestHandled,
    sessionDoc.ready,
    sessionDoc.synced,
    suggestedAddress,
  ]);

  const navigate = useCallback(() => {
    let parsed: BrowserAddress;
    try {
      parsed = parseBrowserAddress(address);
    } catch (parseError) {
      setError(
        parseError instanceof BrowserAddressError
          ? parseError.message
          : t('sessions.browser.errors.invalidAddress', 'Enter a valid HTTP(S) URL.')
      );
      return;
    }
    void openAddress(parsed, { approved: true });
  }, [address, openAddress, t]);

  const navigateHistory = useCallback(
    (index: number) => {
      const entry = history.entries[index];
      if (!entry) return;
      try {
        void openAddress(parseBrowserAddress(entry), { historyIndex: index, approved: true });
      } catch (parseError) {
        setError(errorMessage(parseError));
      }
    },
    [history.entries, openAddress]
  );

  const handleBack = useCallback(() => {
    if (
      currentAddress?.engine === 'public-web' &&
      publicState?.canGoBack &&
      getPublicBrowserBridge()
    ) {
      void getPublicBrowserBridge()
        ?.back(`session-browser-${session.id}`)
        .then(
          (result) => {
            if (!result.ok) setError(result.error);
          },
          (commandError: unknown) => setError(errorMessage(commandError))
        );
      return;
    }
    if (currentAddress?.engine === 'managed-preview' && managedState?.canGoBack) {
      setManagedCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'back' }));
      return;
    }
    navigateHistory(history.index - 1);
  }, [
    currentAddress?.engine,
    history.index,
    managedState?.canGoBack,
    navigateHistory,
    publicState?.canGoBack,
    session.id,
  ]);

  const handleForward = useCallback(() => {
    if (
      currentAddress?.engine === 'public-web' &&
      publicState?.canGoForward &&
      getPublicBrowserBridge()
    ) {
      void getPublicBrowserBridge()
        ?.forward(`session-browser-${session.id}`)
        .then(
          (result) => {
            if (!result.ok) setError(result.error);
          },
          (commandError: unknown) => setError(errorMessage(commandError))
        );
      return;
    }
    if (currentAddress?.engine === 'managed-preview' && managedState?.canGoForward) {
      setManagedCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'forward' }));
      return;
    }
    navigateHistory(history.index + 1);
  }, [
    currentAddress?.engine,
    history.index,
    managedState?.canGoForward,
    navigateHistory,
    publicState?.canGoForward,
    session.id,
  ]);

  const handleReload = useCallback(() => {
    if (currentAddress?.engine === 'public-web' && getPublicBrowserBridge()) {
      void getPublicBrowserBridge()
        ?.reload(`session-browser-${session.id}`)
        .then(
          (result) => {
            if (!result.ok) setError(result.error);
          },
          (commandError: unknown) => setError(errorMessage(commandError))
        );
      return;
    }
    if (viewerUrl) {
      setManagedLoading(true);
      setManagedCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'reload' }));
      return;
    }
    if (currentAddress?.engine === 'managed-preview' && currentAddress.target) {
      // The endpoint is gone (released or never acquired): reloading means
      // reopening the address. The explicit click authorizes the loopback target.
      void openAddress(currentAddress, { approved: currentAddress.targetClass === 'loopback' });
    }
  }, [currentAddress, openAddress, session.id, viewerUrl]);

  const handleStop = useCallback(() => {
    if (currentAddress?.engine === 'public-web' && getPublicBrowserBridge()) {
      void getPublicBrowserBridge()
        ?.stop(`session-browser-${session.id}`)
        .then(
          (result) => {
            if (!result.ok) setError(result.error);
          },
          (commandError: unknown) => setError(errorMessage(commandError))
        );
      return;
    }
    if (currentAddress?.engine === 'managed-preview' && annotationAvailable) {
      setManagedCommand((current) => ({ id: (current?.id ?? 0) + 1, action: 'stop' }));
      setManagedLoading(false);
    }
  }, [annotationAvailable, currentAddress?.engine, session.id]);

  const copyUrl = useCallback(
    async (url: string) => {
      if (!(await writeTextToClipboard(url))) {
        toast.error(t('sessions.browser.copyFailed', 'Failed to copy URL'));
        return;
      }
      toast.success(t('sessions.browser.copied', 'Copied URL'));
    },
    [t]
  );

  const handleShare = useCallback(async () => {
    if (!currentAddress) return;
    if (currentAddress.engine === 'public-web') return copyUrl(currentAddress.logicalUrl);
    if (!currentAddress.target) return;
    setSharing(true);
    setBusy(true);
    try {
      const shared = await createRemotePreview(
        { ...currentAddress, engine: 'managed-preview', target: currentAddress.target },
        'share_action',
        { activateViewer: !(isLocalDesktopSession && localEndpointRef.current) }
      );
      if (shared) await copyUrl(shared.viewerUrl);
    } catch (shareError) {
      setError(errorMessage(shareError));
    } finally {
      setBusy(false);
      setSharing(false);
    }
  }, [copyUrl, createRemotePreview, currentAddress, isLocalDesktopSession]);

  const restorePreview = useCallback(async () => {
    if (currentAddress?.engine !== 'managed-preview' || !currentAddress.target) return;
    setBusy(true);
    try {
      const restored = await createRemotePreview(
        { ...currentAddress, engine: 'managed-preview', target: currentAddress.target },
        'share_action',
        { restart: true, activateViewer: !isLocalDesktopSession }
      );
      if (restored)
        toast.success(
          t(
            'sessions.browser.connection.restored',
            'Preview restored. The share link has changed.'
          ),
          {
            action: {
              label: t('sessions.browser.connection.copyNewLink', 'Copy new link'),
              onClick: () => void copyUrl(restored.viewerUrl),
            },
          }
        );
    } catch (restoreError) {
      setPreviewStatusError(errorMessage(restoreError));
    } finally {
      setBusy(false);
    }
  }, [copyUrl, createRemotePreview, currentAddress, isLocalDesktopSession, t]);

  const stopSharing = useCallback(async () => {
    if (!runtime || !user?.id) {
      setError(
        t('sessions.browser.errors.runtimeUnavailable', 'The session runtime is unavailable.')
      );
      return;
    }
    setBusy(true);
    previewObservationEpoch.current += 1;
    previewControlInFlight.current = true;
    try {
      const response = await runtime.requestSessionPreviewRevoke(
        session.machineId,
        session.id,
        user.id,
        { reason: 'user_revoked' }
      );
      if (!response?.success) {
        setError(
          response?.message ??
            t('sessions.browser.errors.revokeFailed', 'Sharing could not be stopped.')
        );
      } else if (localEndpoint) {
        setRemoteConnection(response.connection);
        setLocalEndpoint({ ...localEndpoint, shareUrl: undefined });
        localEndpointRef.current = { ...localEndpoint, shareUrl: undefined };
      } else {
        setRemoteConnection(response.connection);
        clearManagedPreviewFrame(session.id);
        setViewerUrl(null);
        setAnnotationEnabled(false);
        setAnnotationAvailable(false);
      }
    } catch (revokeError) {
      setError(errorMessage(revokeError));
    } finally {
      previewControlInFlight.current = false;
      previewObservationEpoch.current += 1;
      setBusy(false);
    }
  }, [localEndpoint, runtime, session.id, session.machineId, t, user?.id]);

  const handlePublicState = useCallback(
    (state: ElectronPublicBrowserState) => {
      setPublicState(state);
      if (state.url) {
        setAddress(state.url);
        try {
          const parsed = parseBrowserAddress(state.url);
          if (parsed.engine !== 'public-web') {
            setError('Public browser attempted to navigate outside its public-network boundary.');
            return;
          }
          setCurrentAddress(parsed);
          commitHistory(parsed.logicalUrl);
        } catch (stateError) {
          setError(errorMessage(stateError));
          return;
        }
      }
      if (state.error) setError(state.error);
      else setError(null);
    },
    [commitHistory]
  );

  const handlePublicNavigationRequestConsumed = useCallback(
    (request: PublicBrowserNavigationRequest) => {
      setPublicNavigationRequest((current) =>
        current?.id === request.id && current.url === request.url ? null : current
      );
    },
    []
  );

  const handleManagedState = useCallback(
    (state: ManagedBrowserStateMessage['payload']) => {
      setManagedState(state);
      setAddress(state.url);
      try {
        const parsed = parseBrowserAddress(state.url);
        if (parsed.engine !== 'managed-preview') {
          setError('Managed preview attempted to navigate outside its private-network boundary.');
          return;
        }
        setCurrentAddress(parsed);
        commitHistory(parsed.logicalUrl);
        setError(null);
      } catch (stateError) {
        setError(errorMessage(stateError));
      }
    },
    [commitHistory]
  );

  const handleManagedNavigationRequest = useCallback(
    (url: string) => {
      try {
        void openAddress(parseBrowserAddress(url), { fromPageContent: true });
      } catch (navigationError) {
        setError(errorMessage(navigationError));
      }
    },
    [openAddress]
  );

  const loading =
    currentAddress?.engine === 'public-web' ? publicState?.phase === 'loading' : managedLoading;
  const navigationBusy = busy || managedNavigationPhase !== null;
  const canGoBack =
    (currentAddress?.engine === 'public-web' && publicState?.canGoBack === true) ||
    (currentAddress?.engine === 'managed-preview' && managedState?.canGoBack === true) ||
    history.index > 0;
  const canGoForward =
    (currentAddress?.engine === 'public-web' && publicState?.canGoForward === true) ||
    (currentAddress?.engine === 'managed-preview' && managedState?.canGoForward === true) ||
    (history.index >= 0 && history.index < history.entries.length - 1);
  const remoteMachineName =
    machinePlane === 'cloud' ? sessionMachine?.name?.trim() || session.machineId : undefined;
  const hasShareUrl = currentAddress?.engine === 'managed-preview' && !!activeShareUrl;
  const previewUnavailableReason = session.isArchived
    ? t(
        'sessions.browser.connection.sessionEnded',
        'This session is archived. Restore the session first.'
      )
    : user?.id !== session.userId
      ? t(
          'sessions.browser.connection.ownerRequired',
          'Only the session owner can restore this preview.'
        )
      : machineOnline === 'offline'
        ? t(
            'sessions.browser.connection.machineOffline',
            'The session machine is offline. Bring it online to restore preview.'
          )
        : undefined;
  const previewStatusProps = {
    local: isLocalDesktopSession,
    connection: remoteConnection,
    checking: checkingPreview,
    busy: navigationBusy,
    unavailableReason: previewUnavailableReason,
    error: previewStatusError,
    remoteMachineName,
    hasShareUrl,
    onRestore: () => void restorePreview(),
    onStopSharing: () => void stopSharing(),
  };

  return (
    <SessionBrowserPanelView
      className={className}
      toolbar={{
        leadingSlot: leadingSlot,
        focusAddress: active && currentAddress === null,
        address: address,
        canGoBack: canGoBack,
        canGoForward: canGoForward,
        loading: loading,
        annotationEnabled: annotationEnabled,
        annotationAvailable: annotationAvailable,
        sharing: sharing,
        shareAvailable: currentAddress !== null,
        hasShareUrl: currentAddress?.engine === 'managed-preview' && !!activeShareUrl,
        busy: navigationBusy,
        onAddressChange: setAddress,
        onRestoreAddress: () => setAddress(currentAddress?.logicalUrl ?? suggestedAddress),
        onNavigate: navigate,
        onBack: handleBack,
        onForward: handleForward,
        onReload: handleReload,
        onStop: handleStop,
        onToggleAnnotation: () => setAnnotationEnabled((current) => !current),
        onShare: () => void handleShare(),
        onStopSharing: () => void stopSharing(),
      }}
      previewStatus={currentAddress?.engine === 'managed-preview' ? previewStatusProps : undefined}
      error={error}
      onDismissError={() => setError(null)}
      navigationPhase={managedNavigationPhase}
      suggestedAddress={suggestedAddress}
    >
      {currentAddress?.engine === 'public-web' ? (
        <PublicBrowserSurface
          browserId={`session-browser-${session.id}`}
          navigationRequest={publicNavigationRequest}
          active={active && !error}
          onStateChange={handlePublicState}
          onNavigationRequestConsumed={handlePublicNavigationRequestConsumed}
        />
      ) : currentAddress?.engine === 'managed-preview' && viewerUrl ? (
        <ManagedPreviewSurface
          session={session}
          viewerUrl={viewerUrl}
          annotationEnabled={annotationEnabled}
          logicalUrl={currentAddress.logicalUrl}
          command={managedCommand}
          visualAnnotationReferenceKeys={visualAnnotationReferenceKeys}
          onAnnotationAvailabilityChange={setAnnotationAvailable}
          onRuntimeError={setError}
          onLoadingChange={setManagedLoading}
          onBrowserStateChange={handleManagedState}
          onNavigationRequest={handleManagedNavigationRequest}
          onAddVisualAnnotationToChat={onAddVisualAnnotationToChat}
          onToggleVisualAnnotationInChat={onToggleVisualAnnotationInChat}
        />
      ) : null}
    </SessionBrowserPanelView>
  );
}
