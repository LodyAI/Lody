import type { IosSimulatorExterior } from '@lody/shared';
import type { ReactNode, Ref } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  canStartIosSimulatorPreview,
  redactIosSimulatorText,
  getIosSimulatorAspectRatio,
  getIosSimulatorDeviceAction,
  getIosSimulatorStatusUdid,
  type IosSimulatorCatalog,
} from '@/lib/ios-simulator/ios-simulator-model';
import type {
  IosSimulatorDeviceEntry,
  IosSimulatorError,
  IosSimulatorPanelStatus,
  IosSimulatorPreparingStage,
  IosSimulatorViewerState,
} from '@/lib/ios-simulator/ios-simulator-types';
import {
  IosSimulatorConnectionStatus,
  type IosSimulatorPendingAction,
} from './ios-simulator-connection-status';
import {
  IOS_SIMULATOR_PREPARING_STAGES,
  useIosSimulatorButtonLabel,
  useIosSimulatorDeviceStateLabel,
  useIosSimulatorErrorCopy,
  useIosSimulatorStageLabel,
} from './ios-simulator-copy';
import { IosSimulatorControls, type IosSimulatorControlsProps } from './ios-simulator-controls';
import { IosSimulatorDeviceFrame } from './ios-simulator-device-frame';
import { IosSimulatorDevicePicker } from './ios-simulator-device-picker';
import { IosSimulatorViewer, type IosSimulatorViewerHandle } from './ios-simulator-viewer';
import {
  getIosSimulatorHardware,
  type IosSimulatorQuarterTurns,
} from '@/lib/ios-simulator/ios-simulator-hardware';

export type IosSimulatorCatalogState =
  | { phase: 'loading' }
  | { phase: 'error'; error: IosSimulatorError }
  | ({ phase: 'ready' } & IosSimulatorCatalog);

/** Why the panel cannot talk to the machine at all. Checked before anything else. */
export type IosSimulatorPanelBlocker =
  /** The Mac's Lody predates the simulator protocol. */
  | 'upgrade-required'
  /** The Mac is offline and is not this machine. */
  | 'offline';

export type IosSimulatorPanelViewProps = {
  deviceExterior?: { udid: string; geometry: IosSimulatorExterior; imageUrl: string };
  machineName: string;
  blocker: IosSimulatorPanelBlocker | null;
  catalog: IosSimulatorCatalogState;
  refreshing?: boolean;
  selectedUdid: string | null;
  status: IosSimulatorPanelStatus;
  /** What the viewer page last reported for the ready preview. */
  viewerState?: IosSimulatorViewerState | null;
  /** Bumped to reload the viewer page after its stream dropped. */
  viewerReloadKey?: number;
  pendingAction?: IosSimulatorPendingAction;
  /** Whether this start has to boot the device, so the steps list it. */
  bootExpected?: boolean;
  /** The panel is on screen; the viewer is told when it is not. */
  active?: boolean;
  leadingSlot?: ReactNode;
  onSelectDevice: (udid: string) => void;
  onPickerOpenChange?: (open: boolean) => void;
  onRefresh: () => void;
  onStart: (device: IosSimulatorDeviceEntry) => void;
  onCancel: () => void;
  onStop: () => void;
  onRestore: () => void;
  onRetry: () => void;
  onCopyDiagnostics: () => void;
  onViewerStateChange?: (state: IosSimulatorViewerState) => void;
  /**
   * The simulator's native controls and view options. Present only while this
   * Session's preview is ready; everything else about the panel stays as is.
   */
  controls?: Omit<IosSimulatorControlsProps, 'layout'> | null;
  /** `toolbar`: a second row (desktop). `menu`: all controls in one More menu (mobile). */
  controlsLayout?: 'toolbar' | 'menu';
  /** Quarter turns of the exterior; the streamed screen is never rotated. */
  turns?: IosSimulatorQuarterTurns;
  viewerRef?: Ref<IosSimulatorViewerHandle>;
  onRotationChange?: (turns: IosSimulatorQuarterTurns) => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
};

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    backgroundColor: colors.background,
    color: colors.label,
  },
  toolbar: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    paddingInline: space[1.5],
    paddingBottom: space[1.5],
    // Clears the notch in the mobile drill; desktop keeps `--safe-area-top: 0`.
    paddingTop: `calc(${space[1.5]} + var(--safe-area-top, 0px))`,
    containerType: 'inline-size',
  },
  pickerSlot: { display: 'flex', flexGrow: 1, flexShrink: 1, minWidth: 0 },
  statusSlot: { display: 'flex', flexShrink: 0, marginInlineStart: 'auto' },
  /** The region under the toolbar, one luminance step off the page. */
  stage: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    backgroundColor: colors.secondaryBackground,
  },
  center: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    minHeight: 0,
    gap: space[3],
    padding: space[6],
    textAlign: 'center',
  },
  message: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[1],
    maxWidth: '22rem',
  },
  title: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
    overflowWrap: 'anywhere',
  },
  detail: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: '18px',
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
  raw: {
    margin: 0,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
    overflowWrap: 'anywhere',
    maxWidth: '22rem',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1.5],
  },
  /**
   * What the screen says before there is a stream: the device's own glass,
   * empty, at the size the live screen will take — so starting a preview lights
   * it in place. Nothing is on it yet, so it is a well.
   */
  slot: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    width: '100%',
    height: '100%',
    padding: space[4],
    overflow: 'hidden',
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    textAlign: 'center',
  },
  deviceName: {
    margin: 0,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
    color: colors.label,
    overflowWrap: 'anywhere',
  },
  deviceMeta: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  stages: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    textAlign: 'start',
  },
  stageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  stageCurrent: { color: colors.label, fontWeight: 500 },
  stageDone: { color: colors.secondaryLabel },
  stageMark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '14px',
    height: '14px',
    flexShrink: 0,
  },
  stageDot: {
    width: '5px',
    height: '5px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  /** A strip over the live screen when its stream drops; the frame stays put. */
  notice: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: space[2],
    paddingInline: space[4],
    paddingTop: space[3],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    textAlign: 'center',
  },
  viewerColumn: { display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 },
});

function Message({
  title,
  detail,
  raw,
  children,
}: {
  title: string;
  detail?: string;
  raw?: string;
  children?: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.center)} role="status" aria-live="polite">
      <div {...stylex.props(styles.message)}>
        <p {...stylex.props(styles.title)}>{title}</p>
        {detail ? <p {...stylex.props(styles.detail)}>{detail}</p> : null}
      </div>
      {children ? <div {...stylex.props(styles.actions)}>{children}</div> : null}
      {raw ? <p {...stylex.props(styles.raw)}>{redactIosSimulatorText(raw)}</p> : null}
    </div>
  );
}

function DeviceSlot({
  exterior,
  device,
  bezel,
  children,
}: {
  exterior?: IosSimulatorPanelViewProps['deviceExterior'];
  device: IosSimulatorDeviceEntry | null;
  bezel: boolean;
  children: ReactNode;
}) {
  const buttonLabel = useIosSimulatorButtonLabel();
  const hardware = getIosSimulatorHardware(
    device?.family ?? 'iphone',
    device?.deviceType ?? '',
    device?.name ?? ''
  );
  return (
    <IosSimulatorDeviceFrame
      hardware={hardware}
      exterior={exterior?.udid === device?.udid ? exterior : undefined}
      screenAspect={getIosSimulatorAspectRatio(hardware.family)}
      turns={0}
      bezel={bezel && exterior?.udid === device?.udid && !!exterior}
      buttonLabel={buttonLabel}
    >
      <div {...stylex.props(styles.slot)} data-testid="ios-simulator-slot">
        {children}
      </div>
    </IosSimulatorDeviceFrame>
  );
}

function PreparingSteps({
  stage,
  includeBoot,
}: {
  stage: IosSimulatorPreparingStage;
  includeBoot: boolean;
}) {
  const stageLabel = useIosSimulatorStageLabel();
  const steps = IOS_SIMULATOR_PREPARING_STAGES.filter(
    (step) => includeBoot || step !== 'booting' || stage === 'booting'
  );
  const currentIndex = steps.indexOf(stage);
  return (
    <ol {...stylex.props(styles.stages)}>
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        return (
          <li
            key={step}
            {...stylex.props(
              styles.stageRow,
              done && styles.stageDone,
              current && styles.stageCurrent
            )}
            aria-current={current ? 'step' : undefined}
          >
            <span {...stylex.props(styles.stageMark)}>
              {done ? (
                <Check size={14} aria-hidden />
              ) : current ? (
                <Spinner size="small" label={null} />
              ) : (
                <span {...stylex.props(styles.stageDot)} />
              )}
            </span>
            {stageLabel(step)}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Presentation only. The controller owns the Machine RPC calls, polling and the
 * remembered device; this decides what the stage says for each state.
 */
export function IosSimulatorPanelView({
  deviceExterior,
  machineName,
  blocker,
  catalog,
  refreshing = false,
  selectedUdid,
  status,
  viewerState = null,
  viewerReloadKey = 0,
  pendingAction = null,
  bootExpected = false,
  active = true,
  leadingSlot,
  onSelectDevice,
  onPickerOpenChange,
  onRefresh,
  onStart,
  onCancel,
  onStop,
  onRestore,
  onRetry,
  onCopyDiagnostics,
  onViewerStateChange = () => {},
  controls = null,
  controlsLayout = 'toolbar',
  turns = 0,
  viewerRef,
  onRotationChange,
  onFullscreenChange,
}: IosSimulatorPanelViewProps) {
  const { t } = useTranslation();
  const stateLabel = useIosSimulatorDeviceStateLabel();
  const errorCopy = useIosSimulatorErrorCopy();
  const runtimes = catalog.phase === 'ready' ? catalog.runtimes : [];
  const devices = catalog.phase === 'ready' ? catalog.devices : [];
  const deviceByUdid = new Map(devices.map((device) => [device.udid, device]));
  const runtimeByKey = new Map(runtimes.map((runtime) => [runtime.key, runtime]));
  const selected = selectedUdid ? (deviceByUdid.get(selectedUdid) ?? null) : null;
  const statusUdid = getIosSimulatorStatusUdid(status);
  const statusDevice = statusUdid ? (deviceByUdid.get(statusUdid) ?? null) : null;
  const busy = pendingAction !== null;
  const buttonLabel = useIosSimulatorButtonLabel();
  const bezel = (controls?.viewMode ?? 'device') === 'device';

  const copyDiagnosticsButton = (
    <Button type="button" variant="ghost" size="small" onClick={onCopyDiagnostics}>
      <Copy size={14} aria-hidden />
      {t('sessions.iosSimulator.connection.copyDiagnostics', 'Copy diagnostics')}
    </Button>
  );
  const refreshButton = (
    <Button
      type="button"
      variant="secondary"
      size="small"
      disabled={refreshing}
      onClick={onRefresh}
    >
      {t('sessions.iosSimulator.action.refresh', 'Refresh')}
    </Button>
  );

  const renderStage = (): ReactNode => {
    if (blocker === 'upgrade-required') {
      return (
        <Message
          title={t('sessions.iosSimulator.blocker.upgradeTitle', 'Update Lody on {{machine}}', {
            machine: machineName,
          })}
          detail={t(
            'sessions.iosSimulator.blocker.upgradeDetail',
            'Previewing simulators needs a newer Lody on the Mac this session runs on. Update it there, then reopen this tab.'
          )}
        />
      );
    }
    if (blocker === 'offline') {
      return (
        <Message
          title={t('sessions.iosSimulator.blocker.offlineTitle', '{{machine}} is offline', {
            machine: machineName,
          })}
          detail={t(
            'sessions.iosSimulator.blocker.offlineDetail',
            'Its simulators appear here when it’s back online. Nothing on it has been stopped.'
          )}
        />
      );
    }
    if (catalog.phase === 'loading') {
      return (
        <Message
          title={t(
            'sessions.iosSimulator.catalog.loading',
            'Looking for simulators on {{machine}}…',
            { machine: machineName }
          )}
        >
          <Spinner size="small" label={null} />
        </Message>
      );
    }
    if (catalog.phase === 'error') {
      const copy = errorCopy(catalog.error, machineName);
      return (
        <Message title={copy.title} detail={copy.detail} raw={catalog.error.message}>
          {refreshButton}
          {copyDiagnosticsButton}
        </Message>
      );
    }
    if (devices.length === 0) {
      return (
        <Message
          title={t('sessions.iosSimulator.catalog.emptyTitle', 'No simulators on {{machine}}', {
            machine: machineName,
          })}
          detail={t(
            'sessions.iosSimulator.catalog.emptyDetail',
            'Add one in Xcode under Window › Devices and Simulators, then refresh.'
          )}
        >
          {refreshButton}
        </Message>
      );
    }

    const showingStatusDevice = statusUdid !== null && statusUdid === selectedUdid;
    if (showingStatusDevice && status.phase === 'ready') {
      const dropped = viewerState === 'disconnected' || viewerState === 'error';
      return (
        <div {...stylex.props(styles.viewerColumn)}>
          {dropped ? (
            <div {...stylex.props(styles.notice)} role="status">
              {viewerState === 'error'
                ? t('sessions.iosSimulator.viewer.error', 'The viewer hit an error.')
                : t('sessions.iosSimulator.viewer.disconnected', 'The viewer lost its connection.')}
              <Button type="button" variant="secondary" size="mini" onClick={onRestore}>
                {t('sessions.iosSimulator.action.restore', 'Restore')}
              </Button>
            </div>
          ) : null}
          <IosSimulatorViewer
            key={`${status.operationId}:${viewerReloadKey}:${controlsLayout}`}
            ref={viewerRef}
            viewerUrl={status.viewerUrl}
            viewerOrigin={status.viewerOrigin}
            operationId={status.operationId}
            title={t('sessions.iosSimulator.viewerTitle', '{{device}} screen', {
              device: statusDevice?.name ?? '',
            })}
            hardware={getIosSimulatorHardware(
              statusDevice?.family ?? 'iphone',
              statusDevice?.deviceType ?? '',
              statusDevice?.name ?? ''
            )}
            turns={turns}
            rotateWithDevice={controlsLayout !== 'menu'}
            bezel={bezel}
            visible={active}
            onStateChange={onViewerStateChange}
            onRotationChange={onRotationChange}
            onFullscreenChange={onFullscreenChange}
            onPressButton={
              controls?.controlsSupported
                ? (button) => controls.onControl({ kind: 'button', button })
                : undefined
            }
            isPressAvailable={(button) =>
              Boolean(controls?.availability[button]) && controls?.pendingControl !== button
            }
            buttonLabel={buttonLabel}
          />
        </div>
      );
    }
    if (showingStatusDevice && status.phase === 'preparing') {
      return (
        <DeviceSlot exterior={deviceExterior} device={statusDevice} bezel={bezel}>
          <p {...stylex.props(styles.deviceName)}>{statusDevice?.name}</p>
          <PreparingSteps stage={status.stage} includeBoot={bootExpected} />
          <Button
            type="button"
            variant="secondary"
            size="small"
            // Stop names the operation; until the machine answers there is none.
            disabled={!status.operationId || pendingAction === 'cancel'}
            onClick={onCancel}
          >
            {t('sessions.iosSimulator.action.cancel', 'Cancel')}
          </Button>
        </DeviceSlot>
      );
    }
    if (showingStatusDevice && status.phase === 'closed') {
      return (
        <DeviceSlot exterior={deviceExterior} device={statusDevice} bezel={bezel}>
          <p {...stylex.props(styles.deviceName)}>{statusDevice?.name}</p>
          <p {...stylex.props(styles.detail)}>
            {t('sessions.iosSimulator.closed.detail', 'The preview ended.')}{' '}
            {t('sessions.iosSimulator.interrupted.stillRunning', 'The simulator is still running.')}
          </p>
          {status.message ? (
            <p {...stylex.props(styles.raw)}>{redactIosSimulatorText(status.message)}</p>
          ) : null}
          <Button type="button" variant="primary" size="small" disabled={busy} onClick={onRestore}>
            {t('sessions.iosSimulator.action.restore', 'Restore')}
          </Button>
        </DeviceSlot>
      );
    }
    if (status.phase === 'failed' && (statusUdid === null || statusUdid === selectedUdid)) {
      const copy = errorCopy(status.error, machineName);
      return (
        <Message title={copy.title} detail={copy.detail} raw={status.error.message}>
          {status.error.code !== 'denied' && status.error.code !== 'unsupported' ? (
            <Button type="button" variant="primary" size="small" disabled={busy} onClick={onRetry}>
              {t('sessions.iosSimulator.action.retry', 'Try again')}
            </Button>
          ) : null}
          {status.error.code === 'timeout' && status.operationId ? (
            <Button type="button" variant="secondary" size="small" disabled={busy} onClick={onStop}>
              {t('sessions.iosSimulator.action.stop', 'Stop preview')}
            </Button>
          ) : null}
          {copyDiagnosticsButton}
        </Message>
      );
    }

    if (!selected) {
      return (
        <Message
          title={t('sessions.iosSimulator.choose.title', 'Choose a simulator')}
          detail={t(
            'sessions.iosSimulator.choose.detail',
            'Pick a device and OS version above. Simulators in use by another session can’t be previewed here.'
          )}
        />
      );
    }

    const action = getIosSimulatorDeviceAction(selected, status);
    const runtime = runtimeByKey.get(selected.runtimeKey);
    const state = stateLabel(selected, status);
    const switching =
      statusDevice &&
      statusDevice.udid !== selected.udid &&
      (status.phase === 'ready' || status.phase === 'preparing');
    return (
      <DeviceSlot exterior={deviceExterior} device={selected} bezel={bezel}>
        <div {...stylex.props(styles.message)}>
          <p {...stylex.props(styles.deviceName)}>{selected.name}</p>
          <p {...stylex.props(styles.deviceMeta)}>
            {[runtime?.name, state.label].filter(Boolean).join(' · ')}
          </p>
        </div>
        {canStartIosSimulatorPreview(action) ? (
          <Button
            type="button"
            variant="primary"
            size="small"
            disabled={busy}
            onClick={() => onStart(selected)}
          >
            {action.kind === 'start-and-preview'
              ? t('sessions.iosSimulator.action.startAndPreview', 'Start and preview')
              : t('sessions.iosSimulator.action.preview', 'Preview')}
          </Button>
        ) : null}
        {action.kind === 'occupied' ? (
          <p {...stylex.props(styles.detail)}>
            {t(
              'sessions.iosSimulator.occupied.anonymous',
              'Another session is using this simulator. One session controls a simulator at a time.'
            )}
          </p>
        ) : null}
        {action.kind === 'unavailable' ? (
          <p {...stylex.props(styles.detail)}>
            {action.reason ??
              t(
                'sessions.iosSimulator.unavailable.detail',
                'Xcode reports this simulator as unavailable, usually because its runtime is missing.'
              )}
          </p>
        ) : null}
        {action.kind === 'settling' ? (
          <p {...stylex.props(styles.detail)}>
            {t(
              'sessions.iosSimulator.settling.detail',
              'It can be started again once it has shut down.'
            )}
          </p>
        ) : null}
        {switching && canStartIosSimulatorPreview(action) ? (
          <p {...stylex.props(styles.detail)}>
            {t(
              'sessions.iosSimulator.switching.detail',
              'This ends the preview of {{device}}; it keeps running.',
              { device: statusDevice.name }
            )}
          </p>
        ) : null}
        {switching ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            onClick={() => onSelectDevice(statusDevice.udid)}
          >
            {t('sessions.iosSimulator.switching.back', 'Back to {{device}}', {
              device: statusDevice.name,
            })}
          </Button>
        ) : null}
      </DeviceSlot>
    );
  };

  const pickerDisabled = blocker !== null || catalog.phase !== 'ready' || devices.length === 0;
  return (
    <div {...stylex.props(styles.root)} data-testid="ios-simulator-panel">
      <div {...stylex.props(styles.toolbar)}>
        {leadingSlot}
        <div {...stylex.props(styles.pickerSlot)}>
          <IosSimulatorDevicePicker
            runtimes={runtimes}
            devices={devices}
            status={status}
            selectedUdid={selectedUdid}
            disabled={pickerDisabled}
            refreshing={refreshing}
            onSelect={onSelectDevice}
            onOpenChange={onPickerOpenChange}
            onRefresh={onRefresh}
          />
        </div>
        {blocker === null ? (
          <div {...stylex.props(styles.statusSlot)}>
            <IosSimulatorConnectionStatus
              status={status}
              viewerState={viewerState}
              deviceName={statusDevice?.name}
              pendingAction={pendingAction}
              onRetry={onRetry}
              onRestore={onRestore}
              onCancel={onCancel}
              onStop={onStop}
              onCopyDiagnostics={onCopyDiagnostics}
            />
          </div>
        ) : null}
        {controls && controlsLayout === 'menu' ? (
          <IosSimulatorControls layout="menu" {...controls} />
        ) : null}
      </div>
      {controls && controlsLayout === 'toolbar' ? (
        <IosSimulatorControls layout="toolbar" {...controls} />
      ) : null}
      <div {...stylex.props(styles.stage)}>{renderStage()}</div>
    </div>
  );
}
