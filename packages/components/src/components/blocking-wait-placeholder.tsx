import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { AlertTriangle } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import {
  lodyConnectionUiStateAtom,
  lodyControlConnectionStateAtom,
} from '@/atoms/control-connection';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import {
  StatusPage,
  StatusPageActions,
  StatusPageCode,
  StatusPageDetails,
  StatusPageFootnote,
} from '@/components/status-page';
import { HardResetConfirmDialog } from '@/components/error-boundary-fallback';
import { ClearCacheConfirmDialog } from '@/components/settings/clear-cache';
import {
  useWorkspaceDataScopeState,
  type WorkspaceDataScopeObservation,
} from '@/hooks/use-workspace-data-scope-state';
import { readIdleGapMs } from '@/lib/app-activity-gap';
import {
  readLatestBootRequestFailure,
  useLatestBootRequestFailure,
  type BootRequestFailure,
} from '@/lib/boot-request-failures';
import {
  readRecentLocalClear,
  reloadApp,
  restartIntoCacheClear,
  startHardReset,
  type LocalClearRecord,
} from '@/lib/clear-local-cache';
import { collectClientBuildInfo } from '@/lib/client-build-info';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { writeTextToClipboard } from '@/lib/clipboard';
import { deferredPostHog } from '@/lib/deferred-posthog';
import {
  buildErrorBoundaryReport,
  collectErrorBoundaryEnvironment,
} from '@/lib/error-boundary-report';
import { capturePostHogEvent, type PostHogAnalyticsProperties } from '@/lib/posthog-analytics';
import { reportRecoveryOutcome } from '@/lib/recovery-outcome';
import { recordClientLog } from '@/lib/client-log';
import { getSessionRenderTraceText, recordSessionRenderTrace } from '@/lib/session-render-trace';
import type { WorkspaceDataScopeBlocker } from '@/lib/workspace-data-scope';

/** How long a blocking wait may last before its ways out are offered. */
export const BLOCKING_WAIT_RECOVERY_DELAY_MS = 30_000;

const COPIED_RESET_MS = 2000;

const styles = stylex.create({
  quietLink: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    fontWeight: 500,
    cursor: 'pointer',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    textDecorationLine: 'underline',
    textUnderlineOffset: '3px',
    textDecorationColor: `color-mix(in oklab, transparent, ${colors.secondaryLabel} 50%)`,
  },
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 8%)`,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
  },
  messageMark: {
    flexShrink: 0,
    width: '14px',
    height: '14px',
    marginTop: '1px',
    color: colors.destructive,
  },
});

/**
 * Blockers nothing retries within this page load: the runtime or its first
 * metadata scan rejected while reading local storage. Every other blocker can
 * still resolve on its own.
 */
export function isTerminalWorkspaceOpenBlocker(blocker: WorkspaceDataScopeBlocker): boolean {
  return blocker === 'runtime_init_failed' || blocker === 'doc_meta_scan_failed';
}

/**
 * Error names a local-storage read fails with: IndexedDB `DOMException`s and
 * loro-repo's `RepoStorageError`. A runtime that failed for anything else (a
 * transport or protection requirement, say) is not evidence of damaged local
 * data, and the page must not say it is.
 */
const LOCAL_STORAGE_ERROR_NAMES = new Set([
  'RepoStorageError',
  'UnknownError',
  'InvalidStateError',
  'QuotaExceededError',
  'DataError',
  'VersionError',
  'NotReadableError',
  'ConstraintError',
  'TransactionInactiveError',
  'ReadOnlyError',
]);

/** Whether the wait failed reading local storage, so a cache clear is the fitting answer. */
export function isLocalStorageFailure(observation: WorkspaceDataScopeObservation): boolean {
  const blocker = blockerOf(observation);
  if (blocker === 'doc_meta_scan_failed') return true;
  return (
    blocker === 'runtime_init_failed' &&
    observation.runtimeInitErrorType !== null &&
    LOCAL_STORAGE_ERROR_NAMES.has(observation.runtimeInitErrorType)
  );
}

function blockerOf(observation: WorkspaceDataScopeObservation): WorkspaceDataScopeBlocker | null {
  return observation.scope?.status === 'switching' ? observation.scope.blocker : null;
}

export type RecoveryDiagnosticsInput = {
  gate: string;
  observation: WorkspaceDataScopeObservation;
  waitedMs: number;
  connectionUiState: string;
  controlConnectionState: string;
  lastLocalClear: LocalClearRecord | null;
  requestFailure: BootRequestFailure | null;
  idleGapMs: number | null;
  environment: ReturnType<typeof collectErrorBoundaryEnvironment>;
  renderTrace: string | undefined;
};

function formatRequestFailure(failure: BootRequestFailure | null): string {
  if (failure === null) return 'none';
  return [
    `${failure.source}: ${failure.kind}`,
    failure.status === null ? null : `HTTP ${failure.status}`,
    failure.code,
    failure.message === null ? null : `"${failure.message}"`,
    `at ${new Date(failure.atMs).toISOString()}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

const isoOrNever = (ms: number | null) => (ms === null ? 'never' : new Date(ms).toISOString());

/** The copyable report: which gate held, why, then the crash-report context. */
export function buildRecoveryDiagnostics(input: RecoveryDiagnosticsInput): string {
  const { observation, lastLocalClear } = input;
  const report = buildErrorBoundaryReport({
    error: `Lody did not open: ${input.gate}`,
    boundaryName: 'blocking-wait',
    environment: input.environment,
    renderTrace: input.renderTrace,
  });
  const fields: Array<[string, string | null]> = [
    ['Gate', input.gate],
    ['Workspace data blocker', blockerOf(observation) ?? 'none'],
    ['Workspace', observation.targetSlug],
    ['Runtime workspace id', observation.workspaceId],
    ['Organizations ready', observation.organizationsReady ? 'yes' : 'no'],
    ['Runtime init error', observation.runtimeInitErrorType],
    ['Doc metadata scan error', observation.docMetaScanErrorType],
    // One placeholder can stand in for several gates in turn; this is the whole wait.
    ['Waited (all gates)', `${Math.round(input.waitedMs / 1000)}s`],
    [
      'Idle before launch',
      input.idleGapMs === null ? null : `${Math.round(input.idleGapMs / 3_600_000)}h`,
    ],
    ['Connection', `${input.connectionUiState} (control: ${input.controlConnectionState})`],
    ['Failing request', formatRequestFailure(input.requestFailure)],
    [
      'Local clear in the last day',
      lastLocalClear === null
        ? 'none'
        : `${lastLocalClear.mode} at ${isoOrNever(lastLocalClear.atMs)}, ${
            lastLocalClear.ok ? 'complete' : `${lastLocalClear.failedCount} database(s) left`
          }`,
    ],
  ];
  const section = fields
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  return [report.summary, section, report.details].filter(Boolean).join('\n\n');
}

function captureSafely(name: string, properties: PostHogAnalyticsProperties): void {
  try {
    capturePostHogEvent(deferredPostHog, name, properties);
  } catch {
    // Diagnostics must never stop a recovery.
  }
}

/**
 * One report per screen that offered the ways out: the blocking wait that ran
 * long or failed, and the error screen that had none of its own.
 */
export function reportRecoveryShown(
  gate: string,
  observation: WorkspaceDataScopeObservation,
  failed: boolean
): void {
  const blocker = blockerOf(observation);
  const lastLocalClear = readRecentLocalClear(Date.now());
  const requestFailure = readLatestBootRequestFailure();
  console.warn('[blocking-wait] offering recovery', { gate, blocker, failed });
  recordSessionRenderTrace(`blocking-wait recovery ${gate} ${blocker ?? '-'}`);
  recordClientLog(failed ? 'error' : 'warn', 'boot.wait_stuck', undefined, {
    gate,
    blocker: blocker ?? null,
    docMetaScanErrorType: observation.docMetaScanErrorType ?? null,
    runtimeInitErrorType: observation.runtimeInitErrorType ?? null,
    requestFailure: requestFailure
      ? `${requestFailure.source}:${requestFailure.kind}:${requestFailure.status ?? '-'}`
      : null,
  });
  captureSafely('workspace/boot_wait_stuck', {
    gate,
    failed,
    blocker,
    organizations_ready: observation.organizationsReady,
    doc_meta_scan_error_type: observation.docMetaScanErrorType,
    runtime_init_error_type: observation.runtimeInitErrorType,
    idle_gap_ms: readIdleGapMs(),
    app_version: collectClientBuildInfo().appVersion ?? null,
    last_local_clear_mode: lastLocalClear?.mode ?? null,
    last_local_clear_ok: lastLocalClear?.ok ?? null,
    request_failure_source: requestFailure?.source ?? null,
    request_failure_kind: requestFailure?.kind ?? null,
    request_failure_status: requestFailure?.status ?? null,
    request_failure_code: requestFailure?.code ?? null,
  });
  reportRecoveryOutcome('stuck_again', gate);
}

type RecoveryState = 'waiting' | 'slow' | 'failed';

/**
 * A wait becomes the recovery page once it fails for good (a terminal workspace
 * blocker) or outlasts `delayMs`. Nothing here clears anything on its own: the
 * local replica can hold edits that never synced, and a failure that looks
 * terminal can be transient, so every destructive step is the person's choice.
 *
 * The placeholder is one instance across route branches, so the timer covers
 * the whole wait, not each gate; the report fires once per instance.
 */
function useBlockingWaitRecovery(
  gate: string,
  observation: WorkspaceDataScopeObservation,
  delayMs: number
): RecoveryState {
  const blocker = blockerOf(observation);
  const failed = blocker !== null && isTerminalWorkspaceOpenBlocker(blocker);
  const [slow, setSlow] = useState(false);
  const latestRef = useRef({ gate, observation, failed });
  latestRef.current = { gate, observation, failed };
  const reportedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  const offered = failed || slow;
  useEffect(() => {
    if (!offered || reportedRef.current) return;
    reportedRef.current = true;
    const latest = latestRef.current;
    reportRecoveryShown(latest.gate, latest.observation, latest.failed);
  }, [offered]);

  if (failed) return 'failed';
  return slow ? 'slow' : 'waiting';
}

/**
 * Every screen that blocks the whole app or workspace while something loads.
 * It stays the ordinary spinner while the wait is ordinary, and becomes a
 * status page with the ways out — reload, clear the local cache, copy
 * diagnostics, wipe — once the wait has failed or outlasted `recoveryDelayMs`.
 * Those ways out otherwise live in Settings, which a person stuck here cannot
 * reach; a waiting screen without them is how users end up reinstalling.
 *
 * `gate` names the wait in reports, so a stuck user's report says which
 * condition never resolved.
 */
export function BlockingWaitPlaceholder({
  gate,
  variant,
  title,
  description,
  recoveryDelayMs = BLOCKING_WAIT_RECOVERY_DELAY_MS,
}: {
  gate: string;
  variant: 'content' | 'boot';
  title: string;
  description?: string;
  recoveryDelayMs?: number;
}) {
  const observation = useWorkspaceDataScopeState();
  const state = useBlockingWaitRecovery(gate, observation, recoveryDelayMs);
  const [waitStartedAt] = useState(() => Date.now());

  if (state === 'waiting') {
    return <LoadingPlaceholder variant={variant} title={title} description={description} />;
  }
  return (
    <RecoveryPage
      layout={variant === 'boot' ? 'window' : 'pane'}
      gate={gate}
      failed={state === 'failed'}
      observation={observation}
      waitStartedAt={waitStartedAt}
    />
  );
}

/** The ways out, once a wait has failed or run long. Exported for `RouteMessage` and stories. */
export function RecoveryPage({
  layout,
  gate,
  failed,
  observation,
  waitStartedAt,
}: {
  layout: 'window' | 'pane';
  gate: string;
  failed: boolean;
  observation: WorkspaceDataScopeObservation;
  waitStartedAt: number;
}) {
  const { t } = useTranslation();
  const connectionUiState = useAtomValue(lodyConnectionUiStateAtom);
  const controlConnectionState = useAtomValue(lodyControlConnectionStateAtom);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearNotStarted, setClearNotStarted] = useState(false);
  const [hardResetOpen, setHardResetOpen] = useState(false);
  const [hardResetting, setHardResetting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastLocalClear] = useState(() => readRecentLocalClear(Date.now()));
  const requestFailure = useLatestBootRequestFailure();
  const storageFailure = isLocalStorageFailure(observation);
  // A clear that already ran in this process and left databases behind may have
  // hit a storage backend that is itself broken; only a retry of that relaunches
  // the desktop (stopping the embedded CLI) instead of reloading this window.
  const relaunchClear = lastLocalClear !== null && !lastLocalClear.ok;

  // Built on demand (copy, or the details open), not on every render.
  const readDiagnostics = () =>
    buildRecoveryDiagnostics({
      gate,
      observation,
      waitedMs: Date.now() - waitStartedAt,
      connectionUiState,
      controlConnectionState,
      lastLocalClear: readRecentLocalClear(Date.now()),
      requestFailure: readLatestBootRequestFailure(),
      idleGapMs: readIdleGapMs(),
      environment: collectErrorBoundaryEnvironment(),
      renderTrace: getSessionRenderTraceText(),
    });

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (await writeTextToClipboard(readDiagnostics())) {
      setCopied(true);
    } else {
      // Blocked: open the text so it can be selected by hand.
      setDetailsOpen(true);
    }
  };

  // A reload keeps the URL, so the clear lands back on this screen's
  // destination. A desktop relaunch opens the default landing instead.
  const handleClear = useCallback(() => {
    setClearing(true);
    void restartIntoCacheClear({ relaunch: relaunchClear }).then((started) => {
      if (started) return;
      setClearing(false);
      setClearOpen(false);
      setClearNotStarted(true);
    });
  }, [relaunchClear]);

  const handleHardReset = useCallback(() => {
    setHardResetting(true);
    void startHardReset().then(
      (started) => {
        if (!started) {
          setHardResetting(false);
          setHardResetOpen(false);
        }
      },
      () => setHardResetting(false)
    );
  }, []);

  const hasTarget = observation.targetSlug !== null;
  return (
    <StatusPage
      layout={layout}
      role={failed ? 'alert' : 'status'}
      illustration="broken"
      title={
        failed
          ? hasTarget
            ? t('workspace.route.recovery.failedTitle')
            : t('workspace.route.recovery.failedTitleGeneric')
          : hasTarget
            ? t('workspace.route.recovery.slowTitle')
            : t('workspace.route.recovery.slowTitleGeneric')
      }
      description={
        storageFailure
          ? t('workspace.route.recovery.description')
          : requestFailure !== null
            ? t('workspace.route.recovery.descriptionRequest')
            : t('workspace.route.recovery.descriptionGeneric')
      }
    >
      <StatusPageActions>
        <Button type="button" size="small" onClick={() => reloadApp()}>
          {t('errorBoundary.reload')}
        </Button>
        <Button type="button" variant="secondary" size="small" onClick={() => setClearOpen(true)}>
          {t('workspace.route.recovery.clearCache')}
        </Button>
        <Button type="button" variant="ghost" size="small" onClick={() => void handleCopy()}>
          {copied ? t('errorBoundary.copied') : t('workspace.route.recovery.copyDiagnostics')}
        </Button>
      </StatusPageActions>

      {requestFailure !== null && !storageFailure ? (
        <p role="status" {...stylex.props(styles.message)}>
          <AlertTriangle {...stylex.props(styles.messageMark)} aria-hidden="true" />
          {t(`workspace.route.recovery.requestFailed.${requestFailure.kind}`, {
            request: t(`workspace.route.recovery.request.${requestFailure.source}`),
            status: requestFailure.status ?? '',
          })}
        </p>
      ) : null}

      {clearNotStarted || (lastLocalClear !== null && !lastLocalClear.ok) ? (
        <p role="status" {...stylex.props(styles.message)}>
          <AlertTriangle {...stylex.props(styles.messageMark)} aria-hidden="true" />
          {t(
            clearNotStarted
              ? 'workspace.route.recovery.clearNotStarted'
              : getIpcServices()
                ? 'workspace.route.recovery.clearIncompleteRelaunch'
                : 'workspace.route.recovery.clearIncomplete'
          )}
        </p>
      ) : null}

      <StatusPageDetails
        label={t('errorBoundary.technicalDetails')}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
      >
        <DiagnosticsText read={readDiagnostics} />
      </StatusPageDetails>

      <StatusPageFootnote>
        <Trans
          i18nKey="workspace.route.recovery.stillStuck"
          components={{
            reset: (
              <button
                type="button"
                {...stylex.props(styles.quietLink)}
                onClick={() => setHardResetOpen(true)}
              />
            ),
          }}
        />
      </StatusPageFootnote>

      <ClearCacheConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        isClearing={clearing}
        onConfirm={handleClear}
      />
      <HardResetConfirmDialog
        open={hardResetOpen}
        onOpenChange={setHardResetOpen}
        isResetting={hardResetting}
        onConfirm={handleHardReset}
      />
    </StatusPage>
  );
}

/** Mounted only while the details are open, so the report is built only then. */
function DiagnosticsText({ read }: { read: () => string }) {
  return <StatusPageCode size="details">{read()}</StatusPageCode>;
}

/** `RecoveryPage` for a screen that has already failed, outside any wait. */
export function FailedScreenRecovery({ gate }: { gate: string }) {
  const observation = useWorkspaceDataScopeState();
  const [shownAt] = useState(() => Date.now());
  return (
    <RecoveryPage
      layout="window"
      gate={gate}
      failed
      observation={observation}
      waitStartedAt={shownAt}
    />
  );
}
