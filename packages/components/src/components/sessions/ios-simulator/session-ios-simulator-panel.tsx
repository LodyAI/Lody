import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  machineSupportsIosSimulatorControls,
  machineSupportsIosSimulatorExterior,
  IosSimulatorExteriorAssetSchema,
  isIosSimulatorBezelPng,
  type IosSimulatorExterior,
  type IosSimulatorCommand,
  type IosSimulatorDeviceControl,
  type IosSimulatorResponse,
  type SessionMeta,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { machineOnlineStatusAtomFamily } from '@/atoms/presence';
import { writeTextToClipboard } from '@/lib/clipboard';
import { downloadBytesAsFile } from '@/lib/download-file';
import {
  getIosSimulatorScreenshotFileName,
  type IosSimulatorCaptureError,
} from '@/lib/ios-simulator/ios-simulator-controls';
import {
  getIosSimulatorControlAvailability,
  getIosSimulatorHardware,
  type IosSimulatorControlId,
  type IosSimulatorQuarterTurns,
} from '@/lib/ios-simulator/ios-simulator-hardware';
import { toast } from '@/lib/toast';
import {
  IOS_SIMULATOR_PREPARING_MAX_POLLS,
  IOS_SIMULATOR_PREPARING_POLL_MS,
  buildIosSimulatorDiagnostics,
  getIosSimulatorOperationId,
  getIosSimulatorPanelAvailability,
  getIosSimulatorStatusUdid,
  readIosSimulatorSelectedDevice,
  resolveIosSimulatorSelection,
  toIosSimulatorCatalog,
  toIosSimulatorPanelStatus,
  writeIosSimulatorSelectedDevice,
  type IosSimulatorPreferenceScope,
} from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDeviceEntry,
  IosSimulatorPanelStatus,
  IosSimulatorViewerState,
  IosSimulatorViewerDiagnostics,
} from '@/lib/ios-simulator/ios-simulator-types';
import type { IosSimulatorPendingAction } from './ios-simulator-connection-status';
import type { IosSimulatorScreenshotTarget, IosSimulatorViewMode } from './ios-simulator-controls';
import { IosSimulatorInputDialog, type IosSimulatorInputKind } from './ios-simulator-input-dialog';
import type { IosSimulatorViewerHandle } from './ios-simulator-viewer';
import {
  IosSimulatorPanelView,
  type IosSimulatorCatalogState,
  type IosSimulatorPanelBlocker,
} from './ios-simulator-panel-view';

type SessionIosSimulatorPanelProps = {
  session: Pick<SessionMeta, 'id' | 'machineId'>;
  /** On screen: the only state in which it polls; the viewer is told otherwise. */
  active?: boolean;
  leadingSlot?: ReactNode;
  /** `menu` on mobile: every simulator control lives in one More menu. */
  controlsLayout?: 'toolbar' | 'menu';
  /**
   * Adds a screenshot to the current Session's composer as an attachment.
   * Returns false when there is no composer to take it. Never sends.
   */
  onAttachScreenshot?: (file: File) => boolean;
};

const controlIdOf = (control: IosSimulatorDeviceControl): IosSimulatorControlId => {
  switch (control.kind) {
    case 'button':
      return control.button;
    case 'rotate':
      return control.direction === 'left' ? 'rotate-left' : 'rotate-right';
    default:
      return control.kind;
  }
};

const IDLE: IosSimulatorPanelStatus = { phase: 'idle' };

const appOrigin = (): string => (typeof window === 'undefined' ? '' : window.location.origin);

/**
 * The iOS Simulator side panel for one Session. Its state is its own — never
 * the Browser's — and it is keyed by Session and machine so nothing carries
 * across an in-place switch. Unmounting never stops a preview: panel mount is
 * not preview ownership.
 */
export function SessionIosSimulatorPanel(props: SessionIosSimulatorPanelProps) {
  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  return (
    <SessionIosSimulatorPanelController
      key={`${user?.id}:${runtime?.workspaceId}:${props.session.id}:${props.session.machineId}`}
      {...props}
    />
  );
}

function SessionIosSimulatorPanelController({
  session,
  active = true,
  leadingSlot,
  controlsLayout = 'toolbar',
  onAttachScreenshot,
}: SessionIosSimulatorPanelProps) {
  const { t } = useTranslation();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const user = useAtomValue(userAtom);
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(session.machineId));
  const machineOnline = useAtomValue(machineOnlineStatusAtomFamily(session.machineId));
  const localMachineId = useAtomValue(localMachineIdAtom);
  const isLocalMachine = localMachineId === session.machineId;
  const availability = getIosSimulatorPanelAvailability(machine);
  // Same-machine Electron talks to the local daemon directly, so cloud presence
  // going offline does not cut it off.
  const blocker: IosSimulatorPanelBlocker | null =
    availability === 'upgrade-required'
      ? 'upgrade-required'
      : machineOnline === 'offline' && !isLocalMachine
        ? 'offline'
        : null;

  const preferenceScope = useMemo<IosSimulatorPreferenceScope | null>(
    () =>
      runtime
        ? {
            accountId: user?.id,
            workspaceId: runtime.workspaceId,
            machineId: session.machineId,
            sessionId: session.id,
          }
        : null,
    [runtime, session.id, session.machineId, user?.id]
  );

  const [catalog, setCatalog] = useState<IosSimulatorCatalogState>({ phase: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<IosSimulatorPanelStatus>(IDLE);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [viewerState, setViewerState] = useState<IosSimulatorViewerState | null>(null);
  const [viewerDiagnostics, setViewerDiagnostics] = useState<IosSimulatorViewerDiagnostics | null>(
    null
  );
  const [viewerReloadKey, setViewerReloadKey] = useState(0);
  const [pendingAction, setPendingAction] = useState<IosSimulatorPendingAction>(null);
  const [bootExpected, setBootExpected] = useState(false);
  const [chosenUdid, setChosenUdid] = useState<string | null>(null);
  const [preferredUdid] = useState(() => readIosSimulatorSelectedDevice(preferenceScope));

  // Every status read takes a ticket; an answer to an older ticket is stale.
  // Actions bump it too, so a poll that raced an action loses to it.
  const statusEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const catalogEpoch = useRef(0);

  const requesterUserId = user?.id ?? null;
  const request = useCallback(
    async (command: IosSimulatorCommand): Promise<IosSimulatorResponse | null> => {
      if (!runtime || !requesterUserId) return null;
      return runtime.requestIosSimulatorControl({
        machineId: session.machineId,
        sessionId: session.id,
        requestedByUserId: requesterUserId,
        command,
        timeoutMs: command.action === 'exterior' ? 45000 : undefined,
      });
    },
    [requesterUserId, runtime, session.id, session.machineId]
  );

  const refreshCatalog = useCallback(async () => {
    const epoch = ++catalogEpoch.current;
    setRefreshing(true);
    try {
      const response = await request({ action: 'list' });
      if (!response || epoch !== catalogEpoch.current) return;
      setCatalog(
        response.success
          ? { phase: 'ready', ...toIosSimulatorCatalog(response.devices ?? []) }
          : {
              phase: 'error',
              error: { code: response.error ?? 'failed', message: response.message },
            }
      );
    } finally {
      if (epoch === catalogEpoch.current) setRefreshing(false);
    }
  }, [request]);

  const refreshStatus = useCallback(
    async (operationId?: string) => {
      const epoch = ++statusEpoch.current;
      const current = statusRef.current;
      // Recovery discovers the session's current operation, including agent starts.
      // Only preparation polls bind the operation already on screen.
      const response = await request({ action: 'status', operationId });
      if (!response || epoch !== statusEpoch.current) return;
      // A status read that did not reach the machine keeps what is on screen;
      // only an authoritative answer changes the preview's phase.
      if (!response.success && response.error === 'failed') return;
      if (
        !operationId &&
        response.success &&
        response.preview &&
        response.preview.operationId !== getIosSimulatorOperationId(current)
      ) {
        // An external replacement supersedes the prior operation's device choice.
        setChosenUdid(null);
      }
      setStatus(
        toIosSimulatorPanelStatus(response, {
          udid: getIosSimulatorStatusUdid(current) ?? undefined,
          appOrigin: appOrigin(),
        })
      );
    },
    [request]
  );

  const connected = Boolean(runtime && requesterUserId);
  const live = active && blocker === null && connected;
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!live) return;
    if (!loadedRef.current) {
      loadedRef.current = true;
      void refreshCatalog();
    }
    void refreshStatus();
  }, [live, refreshCatalog, refreshStatus]);

  // Preparing is polled, and only so long. Polls count per operation.
  const operationId = getIosSimulatorOperationId(status);
  // Re-arms the poll even when an answer leaves the status unchanged.
  const [pollTick, setPollTick] = useState(0);
  const pollCount = useRef<{ operationId: string | null; count: number }>({
    operationId: null,
    count: 0,
  });
  const polling =
    live && pendingAction === null && status.phase === 'preparing' && operationId !== null;
  useEffect(() => {
    if (!polling || !operationId) return undefined;
    if (pollCount.current.operationId !== operationId) {
      pollCount.current = { operationId, count: 0 };
    }
    if (pollCount.current.count >= IOS_SIMULATOR_PREPARING_MAX_POLLS) {
      statusEpoch.current += 1;
      setStatus((current) =>
        current.phase === 'preparing' && current.operationId === operationId
          ? { phase: 'failed', udid: current.udid, operationId, error: { code: 'timeout' } }
          : current
      );
      return undefined;
    }
    const timer = setTimeout(() => {
      pollCount.current.count += 1;
      void refreshStatus(operationId).finally(() => setPollTick((tick) => tick + 1));
    }, IOS_SIMULATOR_PREPARING_POLL_MS);
    return () => clearTimeout(timer);
  }, [operationId, pollTick, polling, refreshStatus]);

  // A new operation has a new viewer, which has not said anything yet.
  useEffect(() => {
    setViewerState(null);
    setViewerDiagnostics(null);
  }, [operationId]);

  // A preview that settles changes what the list says (booted, held by us).
  const previousPhase = useRef(status.phase);
  useEffect(() => {
    const was = previousPhase.current;
    previousPhase.current = status.phase;
    if (was === 'preparing' && status.phase !== 'preparing' && live) void refreshCatalog();
  }, [live, refreshCatalog, status.phase]);

  const devices = useMemo(() => (catalog.phase === 'ready' ? catalog.devices : []), [catalog]);
  const selectedUdid = resolveIosSimulatorSelection(devices, {
    chosenUdid,
    preferredUdid,
    status,
  });

  const [deviceExterior, setDeviceExterior] = useState<{
    udid: string;
    geometry: IosSimulatorExterior;
    imageUrl: string;
  }>();
  const exteriorUdid = selectedUdid;
  const supportsExterior = machineSupportsIosSimulatorExterior(machine);
  useEffect(() => {
    if (!live || !exteriorUdid || !supportsExterior) return undefined;
    let cancelled = false;
    let imageUrl: string | undefined;
    void request({ action: 'exterior', udid: exteriorUdid })
      .then((response) => {
        if (cancelled || !response?.success) return;
        const parsed = IosSimulatorExteriorAssetSchema.safeParse(response.exterior);
        if (!parsed.success) return;
        const bytes = Uint8Array.from(atob(parsed.data.pngBase64), (char) => char.charCodeAt(0));
        if (!isIosSimulatorBezelPng(bytes, parsed.data.geometry)) return;
        imageUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        setDeviceExterior({ udid: exteriorUdid, geometry: parsed.data.geometry, imageUrl });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      setDeviceExterior(undefined);
    };
  }, [exteriorUdid, live, request, supportsExterior]);

  const handleSelectDevice = useCallback(
    (udid: string) => {
      setChosenUdid(udid);
      writeIosSimulatorSelectedDevice(preferenceScope, udid);
    },
    [preferenceScope]
  );

  const runAction = useCallback(
    async (
      kind: Exclude<IosSimulatorPendingAction, null>,
      udid: string | undefined,
      command: IosSimulatorCommand
    ) => {
      // Only a newer action supersedes this one. A poll never does: it would
      // drop the answer and leave the action pending forever.
      const actionId = ++actionEpoch.current;
      statusEpoch.current += 1;
      setPendingAction(kind);
      try {
        const response = await request(command);
        if (!response || actionId !== actionEpoch.current) return;
        // Polls issued before this answer are older than it.
        statusEpoch.current += 1;
        setStatus(
          command.action === 'stop' && response.success
            ? IDLE
            : toIosSimulatorPanelStatus(response, { udid, appOrigin: appOrigin() })
        );
      } finally {
        if (actionId === actionEpoch.current) setPendingAction(null);
        void refreshCatalog();
      }
    },
    [refreshCatalog, request]
  );

  const startPreview = useCallback(
    (device: IosSimulatorDeviceEntry) => {
      setBootExpected(device.state !== 'booted' && device.state !== 'booting');
      handleSelectDevice(device.udid);
      setStatus({ phase: 'preparing', udid: device.udid, stage: 'preparing' });
      void runAction('start', device.udid, { action: 'start', udid: device.udid });
    },
    [handleSelectDevice, runAction]
  );

  const statusUdid = getIosSimulatorStatusUdid(status) ?? undefined;
  const stopOperation = useCallback(
    (kind: 'cancel' | 'stop') => {
      if (!operationId) return;
      void runAction(kind, statusUdid, { action: 'stop', operationId });
    },
    [operationId, runAction, statusUdid]
  );

  const startAgain = useCallback(
    (udid: string) => {
      const device = devices.find((candidate) => candidate.udid === udid);
      if (device) {
        startPreview(device);
        return;
      }
      setBootExpected(false);
      void runAction('start', udid, { action: 'start', udid });
    },
    [devices, runAction, startPreview]
  );

  const handleRestore = useCallback(() => {
    if (status.phase === 'ready') {
      // The stream dropped but the preview may still stand: reload the viewer
      // page and ask the machine where things are.
      setViewerState(null);
      setViewerDiagnostics(null);
      setViewerReloadKey((key) => key + 1);
      void refreshStatus();
      return;
    }
    if (statusUdid) startAgain(statusUdid);
  }, [refreshStatus, startAgain, status.phase, statusUdid]);

  const handleRetry = useCallback(() => {
    if (statusUdid) {
      startAgain(statusUdid);
      return;
    }
    void refreshCatalog();
    void refreshStatus();
  }, [refreshCatalog, refreshStatus, startAgain, statusUdid]);

  const handleViewerStateChange = useCallback(
    (next: IosSimulatorViewerState, diagnostics?: IosSimulatorViewerDiagnostics | null) => {
      setViewerState(next);
      if (diagnostics !== undefined) setViewerDiagnostics(diagnostics);
      // A dropped stream may mean the preview itself ended; ask once.
      if (next === 'disconnected' || next === 'error') void refreshStatus();
    },
    [refreshStatus]
  );

  const handlePickerOpenChange = useCallback(
    (open: boolean) => {
      if (open && live) void refreshCatalog();
    },
    [live, refreshCatalog]
  );

  // ---------------------------------------------------------------------------
  // Native controls, screenshots and the view. All of it acts on this Session's
  // ready preview, through its exact operation.

  const viewerRef = useRef<IosSimulatorViewerHandle>(null);
  const [turns, setTurns] = useState<IosSimulatorQuarterTurns>(0);
  const [viewMode, setViewMode] = useState<IosSimulatorViewMode>('device');
  const [fullscreen, setFullscreen] = useState(false);
  const controlTicket = useRef<object | null>(null);
  const [pendingControl, setPendingControl] = useState<IosSimulatorControlId | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [inputKind, setInputKind] = useState<IosSimulatorInputKind | null>(null);
  const machineName = machine?.name ?? t('sessions.iosSimulator.thisMac', 'this Mac');

  // A new operation is a new stream in its own orientation.
  useEffect(() => {
    setTurns(0);
    controlTicket.current = null;
    setPendingControl(null);
    return () => {
      controlTicket.current = null;
    };
  }, [operationId]);

  const readyOperationId = status.phase === 'ready' ? status.operationId : null;
  const statusDevice = statusUdid
    ? (devices.find((candidate) => candidate.udid === statusUdid) ?? null)
    : null;
  const hardware = useMemo(
    () =>
      getIosSimulatorHardware(
        statusDevice?.family ?? 'iphone',
        statusDevice?.deviceType ?? '',
        statusDevice?.name ?? ''
      ),
    [statusDevice?.deviceType, statusDevice?.family, statusDevice?.name]
  );
  const controlsSupported = machineSupportsIosSimulatorControls(machine);

  const sendControl = useCallback(
    async (control: IosSimulatorDeviceControl): Promise<boolean> => {
      const viewer = viewerRef.current;
      if (!readyOperationId || !viewer || !controlsSupported || controlTicket.current) return false;
      const ticket = {};
      controlTicket.current = ticket;
      const id = controlIdOf(control);
      setPendingControl(id);
      try {
        const response = await viewer.control(control);
        if (controlTicket.current !== ticket || viewerRef.current !== viewer) return false;
        if (response.success) return true;
        toast.error(
          response.error === 'unavailable'
            ? t(
                'sessions.iosSimulator.controls.errorUnavailable',
                'This simulator doesn’t have that control.'
              )
            : response.error === 'unsupported'
              ? t(
                  'sessions.iosSimulator.controls.errorUnsupported',
                  'Update Lody on {{machine}} to use simulator controls.',
                  { machine: machineName }
                )
              : t(
                  'sessions.iosSimulator.controls.errorFailed',
                  'The simulator didn’t respond. Try again.'
                )
        );
        return false;
      } finally {
        if (controlTicket.current === ticket) {
          controlTicket.current = null;
          setPendingControl(null);
        }
      }
    },
    [controlsSupported, machineName, readyOperationId, t]
  );

  const captureErrorMessage = useCallback(
    (error: IosSimulatorCaptureError) =>
      error === 'too-large'
        ? t(
            'sessions.iosSimulator.screenshot.tooLarge',
            'The screenshot is too large to bring over.'
          )
        : error === 'timeout'
          ? t(
              'sessions.iosSimulator.screenshot.timeout',
              'The simulator took too long to take a screenshot.'
            )
          : error === 'unavailable'
            ? t(
                'sessions.iosSimulator.screenshot.unavailable',
                'Screenshots aren’t available until the screen is showing.'
              )
            : t('sessions.iosSimulator.screenshot.failed', 'The screenshot couldn’t be taken.'),
    [t]
  );

  const takeScreenshot = useCallback(
    async (target: IosSimulatorScreenshotTarget) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      setCapturing(true);
      try {
        const result = await viewer.capture();
        if (viewerRef.current !== viewer) return;
        if (!result.ok) {
          toast.error(captureErrorMessage(result.error));
          return;
        }
        const fileName = getIosSimulatorScreenshotFileName(
          statusDevice?.name ?? 'Simulator',
          new Date()
        );
        if (target === 'save') {
          downloadBytesAsFile(fileName, new Uint8Array(result.bytes));
          return;
        }
        const file = new File([result.bytes], fileName, { type: 'image/png' });
        if (onAttachScreenshot?.(file)) {
          toast.success(
            t('sessions.iosSimulator.screenshot.attached', 'Screenshot added to your message'),
            {
              description: t(
                'sessions.iosSimulator.screenshot.attachedDetail',
                'It is sent only when you send the message.'
              ),
            }
          );
        } else {
          toast.error(
            t(
              'sessions.iosSimulator.screenshot.noComposer',
              'Open the session chat to attach a screenshot.'
            )
          );
        }
      } finally {
        setCapturing(false);
      }
    },
    [captureErrorMessage, onAttachScreenshot, statusDevice?.name, t]
  );

  const showingPreview = status.phase === 'ready' && statusUdid === selectedUdid;
  const controls = showingPreview
    ? {
        controlsSupported,
        unsupportedHint: t(
          'sessions.iosSimulator.controls.updateHint',
          'Update Lody on {{machine}} to use simulator controls',
          { machine: machineName }
        ),
        availability: getIosSimulatorControlAvailability(hardware),
        pendingControl,
        capturing,
        canAttach: Boolean(onAttachScreenshot),
        viewMode,
        fullscreen,
        canFullscreen: typeof document !== 'undefined' && document.fullscreenEnabled === true,
        onControl: (control: IosSimulatorDeviceControl) => void sendControl(control),
        onTypeText: () => setInputKind('text'),
        onOpenUrl: () => setInputKind('url'),
        onScreenshot: (target: IosSimulatorScreenshotTarget) => void takeScreenshot(target),
        onViewModeChange: setViewMode,
        onToggleFullscreen: () => viewerRef.current?.toggleFullscreen(),
      }
    : null;

  const handleCopyDiagnostics = useCallback(async () => {
    const device =
      devices.find((candidate) => candidate.udid === (statusUdid ?? selectedUdid)) ?? null;
    const runtimeEntry =
      device && catalog.phase === 'ready'
        ? (catalog.runtimes.find((candidate) => candidate.key === device.runtimeKey) ?? null)
        : null;
    const text = buildIosSimulatorDiagnostics({
      now: new Date(),
      machine: {
        os: machine?.os,
        cliVersion: machine?.cliVersion,
        online: machineOnline,
        local: isLocalMachine,
      },
      availability,
      status,
      viewerState,
      viewerDiagnostics,
      client: {
        online: navigator.onLine,
        visible: document.visibilityState === 'visible',
        webRtc: typeof RTCPeerConnection !== 'undefined',
        webCodecs: typeof VideoDecoder !== 'undefined',
      },
      device,
      runtime: runtimeEntry,
      catalog:
        catalog.phase === 'ready'
          ? { phase: 'ready', deviceCount: catalog.devices.length }
          : catalog.phase === 'error'
            ? {
                phase: 'error',
                errorCode: catalog.error.code,
                errorMessage: catalog.error.message,
              }
            : { phase: blocker ?? 'loading' },
    });
    if (await writeTextToClipboard(text)) {
      toast.success(t('sessions.iosSimulator.diagnosticsCopied', 'Diagnostics copied'));
    } else {
      toast.error(t('sessions.iosSimulator.diagnosticsCopyFailed', 'Couldn’t copy diagnostics'));
    }
  }, [
    availability,
    blocker,
    catalog,
    devices,
    isLocalMachine,
    machine?.cliVersion,
    machine?.os,
    machineOnline,
    selectedUdid,
    status,
    statusUdid,
    t,
    viewerState,
    viewerDiagnostics,
  ]);

  return (
    <>
      <IosSimulatorPanelView
        deviceExterior={deviceExterior}
        machineName={machineName}
        blocker={blocker}
        catalog={catalog}
        refreshing={refreshing}
        selectedUdid={selectedUdid}
        status={status}
        viewerState={viewerState}
        viewerDiagnostics={viewerDiagnostics}
        viewerReloadKey={viewerReloadKey}
        pendingAction={pendingAction}
        bootExpected={bootExpected}
        active={active}
        leadingSlot={leadingSlot}
        onSelectDevice={handleSelectDevice}
        onPickerOpenChange={handlePickerOpenChange}
        onRefresh={() => {
          void refreshCatalog();
          void refreshStatus();
        }}
        onStart={startPreview}
        onCancel={() => stopOperation('cancel')}
        onStop={() => stopOperation('stop')}
        onRestore={handleRestore}
        onRetry={handleRetry}
        onCopyDiagnostics={() => void handleCopyDiagnostics()}
        onViewerStateChange={handleViewerStateChange}
        controls={controls}
        controlsLayout={controlsLayout}
        turns={turns}
        viewerRef={viewerRef}
        onRotationChange={setTurns}
        onFullscreenChange={setFullscreen}
      />
      <IosSimulatorInputDialog
        kind={showingPreview ? inputKind : null}
        deviceName={
          statusDevice?.name ?? t('sessions.iosSimulator.connection.thisDevice', 'the simulator')
        }
        busy={pendingControl === 'text' || pendingControl === 'open-url'}
        onOpenChange={(open) => {
          if (!open) setInputKind(null);
        }}
        onSubmit={(kind, value) =>
          sendControl(
            kind === 'url' ? { kind: 'open-url', url: value } : { kind: 'text', text: value }
          )
        }
      />
    </>
  );
}
