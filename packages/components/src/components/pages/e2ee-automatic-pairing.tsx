import { isRequestUnavailable, requestFailureCode } from '@/lib/e2ee-actionable-failure';
import { classifyE2eeControlFailure, custodyFailureMessage } from '@/lib/e2ee-control-failure';
import { colors as uiColors, shadow as uiShadow } from '@lody/ui/tokens/colors.stylex';
import {
  corner as uiCorner,
  radius as uiRadius,
  text as uiText,
} from '@lody/ui/tokens/scales.stylex';
import { themeSpace as appSpace } from '../../style/theme-scale.stylex';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, ChevronDown, ChevronLeft, CircleCheck, Smartphone } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Input } from '@lody/ui/input';
import { accountPairingErrorCode } from '@lody/platform';
import type {
  E2eeAutomaticPairingReview,
  E2eeAutomaticPairingState,
  E2eeAccountPairingRequestState,
  E2eeWorkspaceRuntime,
} from '@lody/platform';
import { Dialog } from '@/ui/dialog';
import { isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { WINDOW_CAPTION_CLEAR_TOP, WindowDragStrip } from '@/ui/window-drag-region';
import { Drawer } from '@lody/ui/drawer';
import { E2eeAccountPairingRequest } from './e2ee-account-pairing';
import {
  autoPairQrPayload,
  parseAutoPairQr,
  PrivatePairingSurface,
  usePairingPrivacy,
} from './e2ee-instant-qr';
import { LedgerQrCode, useQrCamera } from './e2ee-ledger-verification';
import { useIsHandheldScanner } from '@/hooks/use-mobile';
import {
  E2eeDeviceRequestsContext,
  registerE2eePairLinkHandler,
  retryE2eePairLink,
  useE2eeDeviceRequests,
} from './e2ee-device-requests';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { E2eeLostAccessEntry, type E2eeLostAccessProps } from './e2ee-lost-access';
import { E2eeDevicePairArt } from '../e2ee/e2ee-illustrations';

/** Seconds left until `expiresAt`, ticking once a second; null without a deadline. */
function useSecondsLeft(expiresAt: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt === undefined ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
}
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const POLL_MS = 2000;
/** After 5s of syncing, guide the person to keep Lody open on the approving device. */
const SYNC_SLOW_HINT_MS = 5_000;
/** After 15s of syncing without key failure, surface explicit retry and cancel exits. */
const SYNC_TIMEOUT_MS = 15_000;
const cameraSupported = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
/** The first service or host code carried by a failure, through wrappers. */
function carriedCode(cause: unknown, depth = 0): string | null {
  if (!cause || typeof cause !== 'object' || depth > 3) return null;
  const record = cause as { code?: unknown; data?: unknown; message?: unknown; cause?: unknown };
  if (typeof record.code === 'string') return record.code;
  const data = record.data as { code?: unknown } | null | undefined;
  if (data && typeof data === 'object' && typeof data.code === 'string') return data.code;
  if (typeof record.message === 'string') {
    const match = /\be2ee_([\w-]+)\b/.exec(record.message);
    if (match) return `e2ee_${match[1]}`;
  }
  return carriedCode(record.cause, depth + 1);
}
/** Only an outage retries quietly; a refusal says what went wrong instead of blaming the
 * connection. */
export function automaticPairingErrorKey(cause: unknown): string {
  const known =
    accountPairingErrorCode(cause) ?? accountPairingErrorCode({ code: requestFailureCode(cause) });
  if (known) return `e2ee.accountPair.error.${known}`;
  const code = carriedCode(cause)?.replace(/^e2ee_/, '') ?? null;
  if (/^(?:pairing-unavailable|account_pairing_disabled)$/.test(code ?? ''))
    return 'e2ee.accountPair.error.pairing-unavailable';
  const custody = custodyFailureMessage(classifyE2eeControlFailure(cause).kind);
  if (custody) return custody;
  if (code === 'closed' || isRequestUnavailable(cause)) return 'e2ee.auto.connectionRetry';
  return 'e2ee.accountPair.error.failed';
}
const ComparisonCode = ({ code, hint }: { code: string; hint: string }) => {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(themeStyles.hint)}>
      <p {...stylex.props(pairingStyles.code)} aria-live="polite">
        {`${code.slice(0, 3)} ${code.slice(3)}`}
      </p>
      <p {...stylex.props(themeStyles.hint2)}>{t(hint)}</p>
    </div>
  );
};

/**
 * Full-window pairing surface. In a desktop window its top row belongs to the
 * window chrome (macOS traffic lights or Windows caption buttons), so the back
 * button starts below that row and the row stays draggable.
 */
function PairingPage({ children }: { children: ReactNode }) {
  const fullscreen = useElectronFullscreen();
  const clearTrafficLights = isMacOSElectronRenderer() && !fullscreen;
  return (
    <main
      data-e2ee-pairing-surface=""
      {...stylex.props(themeStyles.glyph)}
      style={{
        paddingTop: clearTrafficLights ? '2.75rem' : `max(1rem, ${WINDOW_CAPTION_CLEAR_TOP})`,
      }}
    >
      <WindowDragStrip position="fixed" />
      {children}
    </main>
  );
}

/** New native device: open once, retain its request, then progress without manual checks. */
export function E2eeAutomaticPairingPage({
  runtime,
  workspaceId,
  onJoined,
  onBack,
  onManual,
  keyFailure,
  onRetryKeys,
  lostAccess,
}: {
  runtime: E2eeWorkspaceRuntime;
  workspaceId: string;
  onJoined: () => void;
  onBack: () => void;
  onManual?: () => void;
  keyFailure?: boolean;
  onRetryKeys?: () => void;
  /** The way out when no other device can approve: restore, go back, or remove. */
  lostAccess?: Omit<E2eeLostAccessProps, 'workspaceId'>;
}) {
  usePairingPrivacy();
  const { t, i18n } = useTranslation();
  const [approvalChoice, setApprovalChoice] = useState<{
    runtime: E2eeWorkspaceRuntime;
    workspaceId: string;
  } | null>(null);
  const needsChoice = Boolean(runtime.requirePersonalComputer || runtime.openBrowserRecovery);
  const canStart =
    !needsChoice ||
    (approvalChoice?.runtime === runtime && approvalChoice.workspaceId === workspaceId);
  const [state, setState] = useState<E2eeAutomaticPairingState | null>(null);
  // Before any early return: every render calls the same hooks.
  const secondsLeft = useSecondsLeft(state?.expiresAt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [blocked, setBlocked] = useState<E2eeAccountPairingRequestState | null>(null);
  const blockedRef = useRef(blocked);
  const [confirmRestart, setConfirmRestart] = useState<E2eeAccountPairingRequestState | null>(null);
  const admitted = useRef(false);
  const completed = useRef(false);
  const joinedRef = useRef(onJoined);
  joinedRef.current = onJoined;
  // Every new device shows its six-digit code; a computer also shows it as a QR code a
  // signed-in phone can scan instead of typing.
  const mobile = useIsHandheldScanner();
  // This device's exact access loss here ends any earlier approval: it is never shown as
  // authorized again.
  const lost = state?.phase === 'revoked' || state?.phase === 'removed';
  const receiving = !lost && (state?.phase === 'syncing' || state?.phase === 'joined');
  const [syncSlowHint, setSyncSlowHint] = useState(false);
  const [syncTimedOut, setSyncTimedOut] = useState(false);
  const [syncAttempt, setSyncAttempt] = useState(0);
  useEffect(() => {
    if (!receiving || keyFailure) {
      setSyncSlowHint(false);
      setSyncTimedOut(false);
      return undefined;
    }
    setSyncSlowHint(false);
    setSyncTimedOut(false);
    const slowTimer = setTimeout(() => setSyncSlowHint(true), SYNC_SLOW_HINT_MS);
    const timer = setTimeout(() => setSyncTimedOut(true), SYNC_TIMEOUT_MS);
    return () => {
      clearTimeout(slowTimer);
      clearTimeout(timer);
    };
  }, [receiving, keyFailure, syncAttempt]);
  useEffect(() => {
    if (!canStart) return undefined;
    let alive = true,
      running = false,
      queued = false;
    setBusy(false);
    setError(null);
    blockedRef.current = null;
    setBlocked(null);
    setConfirmRestart(null);
    const accept = (next: E2eeAutomaticPairingState | null) => {
      if (!alive || !next || next.workspaceId !== workspaceId) return;
      setState(next);
      setError(null);
      if (next.phase === 'joined') {
        if (!completed.current) {
          completed.current = true;
          admitted.current = true;
          joinedRef.current();
        }
      } else if (next.phase === 'syncing' && !admitted.current) {
        admitted.current = true;
        joinedRef.current();
      }
    };
    const tick = async () => {
      if (!alive || completed.current) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        do {
          queued = false;
          const retained = await runtime.automaticPairingState!(workspaceId);
          if (!alive) return;
          accept(
            retained ??
              (completed.current || admitted.current
                ? null
                : await runtime.startAutomaticPairing!(workspaceId))
          );
        } while (queued && alive && !completed.current);
      } catch (cause) {
        if (alive) {
          const code = accountPairingErrorCode(cause);
          setError(automaticPairingErrorKey(cause));
          if (code === 'pairing-elsewhere') {
            try {
              const retained = await runtime.accountPairingRequest?.();
              if (!alive) return;
              if (
                retained?.status === 'waiting' &&
                retained.lookupId &&
                /^[0-9a-f]{32}$/.test(retained.lookupId) &&
                runtime.restartAutomaticPairing
              ) {
                if (blockedRef.current?.lookupId !== retained.lookupId) setConfirmRestart(null);
                blockedRef.current = retained;
                setBlocked(retained);
              } else setError('e2ee.accountPair.error.pairing-update-required');
            } catch {
              // Retain the original refusal; a failed inspection authorizes no cancellation.
            }
          }
        }
      } finally {
        running = false;
      }
    };
    admitted.current = false;
    completed.current = false;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = runtime.subscribeAutomaticPairing?.(() => void tick());
    } catch {
      /* Live discovery is optional; scoped polling still verifies the same originals. */
    }
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    const onOnline = () => void tick();
    window.addEventListener('online', onOnline);
    return () => {
      alive = false;
      unsubscribe?.();
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [runtime, workspaceId, generation, canStart]);
  const ownerRef = useRef({ runtime, workspaceId });
  if (ownerRef.current.runtime !== runtime || ownerRef.current.workspaceId !== workspaceId)
    ownerRef.current = { runtime, workspaceId };
  const sameOwner = (owner: typeof ownerRef.current) => ownerRef.current === owner;
  useEffect(
    () => () => {
      ownerRef.current = { ...ownerRef.current };
    },
    []
  );
  const restartPrevious = async (confirmed: E2eeAccountPairingRequestState) => {
    const owner = ownerRef.current;
    const expectedLookupId = confirmed.lookupId;
    if (busy || !expectedLookupId || !runtime.restartAutomaticPairing) return;
    setBusy(true);
    try {
      const next = await runtime.restartAutomaticPairing(workspaceId, { expectedLookupId });
      if (sameOwner(owner)) {
        blockedRef.current = null;
        setBlocked(null);
        setConfirmRestart(null);
        setState(next);
        setError(null);
        setGeneration((g) => g + 1);
      }
    } catch (cause) {
      if (!sameOwner(owner)) return;
      setConfirmRestart(null);
      setError(`e2ee.accountPair.error.${accountPairingErrorCode(cause) ?? 'failed'}`);
      try {
        const retained = await runtime.accountPairingRequest?.();
        if (!sameOwner(owner)) return;
        if (
          retained?.status === 'waiting' &&
          retained.lookupId &&
          /^[0-9a-f]{32}$/.test(retained.lookupId)
        ) {
          blockedRef.current = retained;
          setBlocked(retained);
        } else {
          blockedRef.current = null;
          setBlocked(null);
        }
      } catch {
        // The captured original remains visible; retry still uses only its exact ID.
      }
    } finally {
      if (sameOwner(owner)) setBusy(false);
    }
  };
  const restart = async (replace = false) => {
    const owner = ownerRef.current;
    if (busy) return;
    setBusy(true);
    try {
      if (replace) await runtime.cancelAutomaticPairing!(workspaceId);
      const next = await runtime.startAutomaticPairing!(workspaceId);
      if (sameOwner(owner)) {
        setState(next);
        setError(null);
        setGeneration((g) => g + 1);
      }
    } catch (cause) {
      if (sameOwner(owner))
        setError(`e2ee.accountPair.error.${accountPairingErrorCode(cause) ?? 'failed'}`);
    } finally {
      if (sameOwner(owner)) setBusy(false);
    }
  };
  const cancel = (manual = false) => {
    ownerRef.current = { runtime, workspaceId };
    setBusy(false);
    // The relay may queue the cancellation while offline: leaving never waits for it.
    // A request it misses still expires, and a new request replaces it.
    void runtime.cancelAutomaticPairing?.(workspaceId).catch(() => undefined);
    if (manual) onManual?.();
    else onBack();
  };
  const recovery = lostAccess?.recovery;
  const recovered = () => {
    // Reached only when this workspace's own restore committed: its pending request is
    // no longer needed. Another workspace's success keeps this request.
    void runtime.cancelAutomaticPairing?.(workspaceId).catch(() => undefined);
    recovery?.onRecovered();
  };
  if (!canStart)
    return (
      <PairingPage>
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('e2ee.control.back')}
        </Button>
        <section {...stylex.props(themeStyles.consentColumn)}>
          <E2eeAccountPairingRequest
            key={workspaceId}
            runtime={runtime}
            workspaceId={workspaceId}
            autoStart={false}
            onJoined={onJoined}
            onRequestApproval={() => setApprovalChoice({ runtime, workspaceId })}
          />
          {lostAccess && (
            <div {...stylex.props(themeStyles.spaced3)} data-testid="e2ee-lost-all-entry">
              <E2eeLostAccessEntry
                {...lostAccess}
                workspaceId={workspaceId}
                workspaceName={lostAccess.workspaceName ?? state?.workspaceName}
                {...(runtime.openBrowserRecovery
                  ? {
                      recovery: undefined,
                      entryVariant: 'link' as const,
                      entryLabel: t('e2ee.lostAccess.entrySecondary'),
                    }
                  : recovery
                    ? { recovery: { ...recovery, onRecovered: recovered } }
                    : {})}
                disabled={busy}
              />
            </div>
          )}
        </section>
      </PairingPage>
    );
  const formatTime = (value: number) =>
    new Intl.DateTimeFormat(toIntlLocaleOrEn(i18n?.language), {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  const terminal =
    !receiving &&
    state &&
    ['declined', 'expired', 'cancelled', 'revoked', 'removed'].includes(state.phase);
  return (
    <PairingPage>
      <Button variant="ghost" onClick={onBack}>
        <ChevronLeft size={16} />
        {t('e2ee.control.back')}
      </Button>
      <section {...stylex.props(themeStyles.column, receiving && themeStyles.receivingColumn)}>
        {receiving && (
          <div {...stylex.props(themeStyles.receivingArt)}>
            <E2eeDevicePairArt width={196} transferring={!keyFailure} />
          </div>
        )}
        <h1 {...stylex.props(themeStyles.copy)}>
          {t(
            terminal
              ? `e2ee.auto.${state.phase}.title`
              : receiving
                ? 'e2ee.auto.syncing.title'
                : 'e2ee.auto.waiting.title'
          )}
        </h1>
        {terminal ? (
          <>
            <p {...stylex.props(themeStyles.hint3)}>{t(`e2ee.auto.${state.phase}.help`)}</p>
            {/* A removed member needs a new invitation; this device cannot ask for one. */}
            {state.phase !== 'removed' && (
              <Button
                xstyle={themeStyles.spaced}
                disabled={busy}
                data-testid={state.phase === 'revoked' ? 'e2ee-auto-pair-again' : undefined}
                onClick={() => void restart()}
              >
                {t(state.phase === 'revoked' ? 'e2ee.devices.pairAgain' : 'e2ee.auto.restart')}
              </Button>
            )}
          </>
        ) : receiving ? (
          <>
            <p role="status" {...stylex.props(themeStyles.hint3)}>
              {t(
                syncSlowHint && !syncTimedOut
                  ? 'e2ee.auto.syncing.keepOpen'
                  : 'e2ee.auto.syncing.help'
              )}
            </p>
            {!keyFailure && syncTimedOut && (
              <div {...stylex.props(themeStyles.spaced2)} data-testid="e2ee-sync-timeout">
                <p role="status" {...stylex.props(themeStyles.hint5)}>
                  {t('e2ee.auto.syncing.slow')}
                </p>
                <div {...stylex.props(themeStyles.row)}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSyncTimedOut(false);
                      setSyncAttempt((attempt) => attempt + 1);
                      if (onRetryKeys) onRetryKeys();
                      else setGeneration((g) => g + 1);
                    }}
                  >
                    {t('e2ee.auto.syncing.retry')}
                  </Button>
                  <Button variant="ghost" onClick={() => cancel()}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )}
            {keyFailure && (
              <div {...stylex.props(themeStyles.spaced2)}>
                <p role="alert" {...stylex.props(themeStyles.hint5)}>
                  {t('e2ee.accountPair.request.keyFailed')}
                </p>
                <Button xstyle={themeStyles.spaced3} variant="secondary" onClick={onRetryKeys}>
                  {t('e2ee.accountPair.request.keyRetry')}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            {state?.workspaceName && (
              <>
                <p {...stylex.props(themeStyles.hint6)}>{t('e2ee.auto.requesting')}</p>
                <p {...stylex.props(themeStyles.layout)}>{state.workspaceName}</p>
              </>
            )}
            {state?.comparisonCode ? (
              <>
                <p role="status" {...stylex.props(themeStyles.row2)}>
                  <CircleCheck size={15} aria-hidden="true" />
                  {t('e2ee.auto.prompted')}
                </p>
                <ComparisonCode code={state.comparisonCode} hint="e2ee.auto.showCode" />
                {!mobile && (
                  <div data-testid="e2ee-auto-pair-qr" {...stylex.props(themeStyles.column2)}>
                    <div {...stylex.props(themeStyles.panel2)}>
                      <LedgerQrCode
                        payload={autoPairQrPayload(state.id, state.comparisonCode)}
                        size={168}
                        label={t('e2ee.auto.desktopQr.label')}
                      />
                    </div>
                    <p {...stylex.props(themeStyles.hint8)}>{t('e2ee.auto.desktopQr.help')}</p>
                  </div>
                )}
                <p {...stylex.props(themeStyles.hint9)}>{t('e2ee.auto.waiting.help')}</p>
              </>
            ) : (
              <div data-testid="e2ee-awaiting-device" {...stylex.props(themeStyles.hint10)}>
                <div {...stylex.props(themeStyles.cardArt)}>
                  <E2eeDevicePairArt width={152} />
                </div>
                <p role="status" {...stylex.props(themeStyles.copy2)}>
                  {t('e2ee.auto.awaiting.title')}
                </p>
                <p {...stylex.props(themeStyles.hint11)}>{t('e2ee.auto.awaiting.help')}</p>
              </div>
            )}
            <details {...stylex.props(themeStyles.hint3)}>
              <summary {...stylex.props(themeStyles.row3)}>
                {t('e2ee.auto.noRequest')}
                <ChevronDown size={14} />
              </summary>
              <p {...stylex.props(themeStyles.copy3)}>{t('e2ee.auto.noRequest.help')}</p>
              <Button variant="link" disabled={busy} onClick={() => void restart(true)}>
                {t('e2ee.auto.changeDevice')}
              </Button>
              {onManual && (
                <Button variant="link" onClick={() => cancel(true)}>
                  {t('e2ee.auto.manual')}
                </Button>
              )}
            </details>
          </>
        )}
        {!receiving && state?.phase !== 'removed' && (
          <>
            {lostAccess ? (
              <div {...stylex.props(themeStyles.spaced3)} data-testid="e2ee-lost-all-entry">
                <E2eeLostAccessEntry
                  {...lostAccess}
                  workspaceId={workspaceId}
                  workspaceName={lostAccess.workspaceName ?? state?.workspaceName}
                  {...(recovery ? { recovery: { ...recovery, onRecovered: recovered } } : {})}
                  disabled={busy}
                />
              </div>
            ) : (
              <details {...stylex.props(themeStyles.hint14)} data-testid="e2ee-lost-all-entry">
                <summary {...stylex.props(themeStyles.row3)}>
                  {t('e2ee.auto.noOtherDevice')}
                  <ChevronDown size={14} />
                </summary>
                <p {...stylex.props(themeStyles.copy3)}>{t('e2ee.auto.noOtherDevice.elsewhere')}</p>
              </details>
            )}
          </>
        )}
        {error && (
          <p role="alert" {...stylex.props(themeStyles.hint4)}>
            {t(error)}
          </p>
        )}
        {blocked && !receiving && (
          <section aria-label={t('e2ee.auto.previous.title')}>
            <p>
              {t('e2ee.auto.previous.help', {
                names: blocked.workspaces.map((w) => w.name).join(', '),
                time: formatTime(blocked.expiresAt),
              })}
            </p>
            {confirmRestart ? (
              <>
                <p>{t('e2ee.auto.previous.confirm')}</p>
                <Button disabled={busy} onClick={() => void restartPrevious(confirmRestart)}>
                  {t('e2ee.auto.previous.endAndRestart')}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmRestart(null)}>
                  {t('e2ee.auto.previous.keep')}
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmRestart(blocked)}
              >
                {t('e2ee.auto.previous.review')}
              </Button>
            )}
          </section>
        )}
        {!terminal && !receiving && (
          <div {...stylex.props(themeStyles.hint15)}>
            {state && (
              <p>
                {secondsLeft !== null && secondsLeft < 60 * 60
                  ? t('e2ee.auto.expiresIn', { time: clock(secondsLeft) })
                  : t('e2ee.auto.expiry', { time: formatTime(state.expiresAt) })}
              </p>
            )}
            <Button variant="ghost" onClick={() => cancel()}>
              {t('e2ee.auto.cancel')}
            </Button>
          </div>
        )}
      </section>
    </PairingPage>
  );
}

function ApprovalExpiry({ expiresAt, inline = false }: { expiresAt: number; inline?: boolean }) {
  const { t } = useTranslation();
  const seconds = useSecondsLeft(expiresAt);
  if (seconds === null || seconds >= 60 * 60) return null;
  const label =
    seconds === 0
      ? t('e2ee.auto.expired.short')
      : t('e2ee.auto.expiresIn', { time: clock(seconds) });
  if (inline) {
    return (
      <span data-testid="e2ee-approval-expiry" {...stylex.props(themeStyles.expiryInline)}>
        {label}
      </span>
    );
  }
  return (
    <p data-testid="e2ee-approval-expiry" {...stylex.props(themeStyles.hint8)}>
      {label}
    </p>
  );
}

/** Persistent application chrome entry for requests a person chose to handle later. */
export function E2eeDeviceRequestsButton({ className }: { className?: string }) {
  const ui = useE2eeDeviceRequests();
  const { t } = useTranslation();
  if (!ui?.count) return null;
  return (
    <Button variant="secondary" className={className} onClick={ui.open}>
      <Smartphone size={15} />
      {t('e2ee.auto.inbox')}
      <span {...stylex.props(themeStyles.hint16)}>{ui.count}</span>
    </Button>
  );
}
/** One account's application-level inbox, shared by desktop and mobile chrome. */
const hasVisiblePairingSurface = () =>
  Array.from(document.querySelectorAll('[data-e2ee-pairing-surface], [role="alertdialog"]')).some(
    (node) => !node.closest('[hidden], [inert], [data-closed], [data-ending-style]')
  );

export function E2eeAutomaticPairingInbox({
  runtime,
  children,
}: {
  runtime?: E2eeWorkspaceRuntime;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<E2eeAutomaticPairingReview[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [inbox, setInbox] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<
    { kind: 'retry' | 'refused'; key: string } | { kind: 'mismatch'; attemptsLeft: number } | null
  >(null);
  const [code, setCode] = useState('');
  // The typed code belongs to one request. A poll that briefly omits it closes the dialog,
  // but reopening the same request keeps the digits and the attempts-left notice.
  const codeOwner = useRef<string | null>(null);
  /** A request this device ended after too many wrong codes; shown until dismissed. */
  const [ended, setEnded] = useState<E2eeAutomaticPairingReview | null>(null);
  const deferred = useRef(new Set<string>());
  /** Monotonic set of request IDs that have reached a terminal outcome in this session
   * (approved, declined or code-locked); never cleared by transient poll gaps. */
  const settled = useRef(new Set<string>());
  const actionOwner = useRef({ runtime });
  if (actionOwner.current.runtime !== runtime) actionOwner.current = { runtime };
  useEffect(
    () => () => {
      actionOwner.current = { ...actionOwner.current };
    },
    []
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const codeRef = useRef(code);
  codeRef.current = code;
  const dialog = useRef<HTMLDivElement>(null);
  // Every device types the new device's code; a phone may scan that screen instead.
  const mobile = useIsHandheldScanner();
  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  /** The code an external auto-pair link carried for one request. While the field still
   * holds it, the window shows the code to compare instead of an input to fill. */
  const [linked, setLinked] = useState<{ id: string; code: string } | null>(null);
  /** Workspaces the person unticked for the open request; every other one is approved. */
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  useEffect(() => {
    let alive = true,
      running = false,
      queued = false;
    setRequests([]);
    busyRef.current = null;
    setBusy(null);
    setError(null);
    codeRef.current = '';
    setCode('');
    codeOwner.current = null;
    setEnded(null);
    selectedRef.current = null;
    setSelected(null);
    deferred.current.clear();
    settled.current.clear();
    if (!runtime?.pendingAutomaticPairing) return;
    const tick = async () => {
      if (!alive) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      setRequests((previous) => previous.filter((row) => row.expiresAt > Date.now()));
      try {
        do {
          queued = false;
          const rawRows = await runtime.pendingAutomaticPairing!();
          if (!alive) return;
          const rows = rawRows.filter((row) => !settled.current.has(row.id));
          setRequests(rows);
          const ids = new Set(rows.map((row) => row.id));
          if (selectedRef.current && !ids.has(selectedRef.current)) {
            selectedRef.current = null;
            setSelected(null);
          }
          // A link scanned with the system camera may name a request fetched only now; claim it
          // before the default first-waiting popup chooses a different row.
          requestsRef.current = rows;
          retryE2eePairLink();
          // A visible window presents even without keyboard focus (another app or a
          // second screen); a hidden one leaves the request to the system notification.
          // It opens over Settings or the encryption console, but never over another
          // pairing surface.
          if (
            !selectedRef.current &&
            !inboxRef.current &&
            document.visibilityState === 'visible' &&
            !hasVisiblePairingSurface()
          ) {
            const next = rows.find(
              (row) =>
                row.phase === 'waiting' &&
                !deferred.current.has(row.id) &&
                !settled.current.has(row.id)
            );
            if (next) {
              selectedRef.current = next.id;
              setSelected(next.id);
            }
          }
        } while (queued && alive);
      } catch {
        /* An inbox outage never gates an existing workspace or clears known requests. */
      } finally {
        running = false;
      }
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = runtime.subscribeAutomaticPairing?.(() => void tick());
    } catch {
      /* Live discovery is optional; scoped polling still verifies the same originals. */
    }
    void tick();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, POLL_MS);
    // Restoring a minimized window presents a waiting request at once.
    const wake = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      alive = false;
      unsubscribe?.();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [runtime]);
  const current = requests.find((row) => row.id === selected);
  const currentSecondsLeft = useSecondsLeft(current?.expiresAt);
  const candidates =
    current?.workspaces ??
    (current ? [{ workspaceId: current.workspaceId, name: current.workspaceName }] : []);
  // The request's own workspace is always approved; the others follow the ticks.
  const chosenIds = candidates
    .map((item) => item.workspaceId)
    .filter((id) => id === current?.workspaceId || !excluded.has(id));
  // A wrong code clears the field, which returns the window to ordinary entry.
  const linkedCode =
    linked && current && linked.id === current.id && code === linked.code ? linked.code : null;
  useEffect(() => {
    if (!selected || selected === codeOwner.current) return;
    codeOwner.current = selected;
    setCode('');
    setError(null);
  }, [selected]);
  useEffect(() => {
    setScanning(false);
    setScanNotice(null);
    setLinked((value) => (value && value.id !== selected ? null : value));
    setExcluded(new Set());
  }, [selected]);
  const later = () => {
    if (selected) deferred.current.add(selected);
    setSelected(null);
    setEnded(null);
    setError(null);
    setLinked(null);
  };
  const act = async (approve: boolean, entered = code) => {
    const target = current;
    if (!target || busy || !runtime || error?.kind === 'refused') return;
    if (approve && (target.phase !== 'waiting' || !/^\d{6}$/.test(entered))) return;
    const owner = actionOwner.current;
    setBusy(target.id);
    setError(null);
    try {
      // Exactly what the window shows, so a list that changed meanwhile signs nothing unseen.
      if (approve) await runtime.approveAutomaticPairing!(target.id, entered, chosenIds);
      else await runtime.declineAutomaticPairing!(target.id);
      if (owner !== actionOwner.current) return;
      deferred.current.add(target.id);
      setSelected(null);
      if (!approve) {
        settled.current.add(target.id);
        setRequests((rows) => rows.filter((row) => row.id !== target.id));
      }
    } catch (cause) {
      if (owner !== actionOwner.current) return;
      const refusal =
        accountPairingErrorCode(cause) ??
        accountPairingErrorCode({ code: requestFailureCode(cause) });
      if (refusal === 'pairing-code-locked') {
        settled.current.add(target.id);
        deferred.current.add(target.id);
        setRequests((rows) => rows.filter((row) => row.id !== target.id));
        setSelected(null);
        setEnded(target);
      } else if (refusal === 'pairing-code-mismatch') {
        const left = (cause as { attemptsLeft?: unknown }).attemptsLeft;
        setCode('');
        setError({ kind: 'mismatch', attemptsLeft: typeof left === 'number' ? left : 1 });
      } else {
        const key = automaticPairingErrorKey(cause);
        const terminal =
          refusal === 'pairing-expired' ||
          refusal === 'pairing-used' ||
          refusal === 'pairing-tampered' ||
          refusal === 'pairing-elsewhere' ||
          refusal === 'pairing-update-required';
        setError({
          kind: terminal ? 'refused' : 'retry',
          key: key === 'e2ee.auto.connectionRetry' ? 'e2ee.accountPair.error.unavailable' : key,
        });
      }
    } finally {
      if (owner === actionOwner.current) setBusy(null);
    }
  };
  const { video: scanVideo, state: scanState } = useQrCamera(
    scanning && Boolean(current),
    (scanned) => {
      setScanning(false);
      const parsed = parseAutoPairQr(scanned);
      // Another request's code is not a wrong entry: nothing is sent, no attempt is used.
      if (!parsed)
        return setScanNotice(
          /^lody:\/\/pair\//i.test(scanned.trim())
            ? 'e2ee.auto.scan.wrongRole'
            : 'e2ee.auto.scan.unreadable'
        );
      if (!current || parsed.id !== current.id) return setScanNotice('e2ee.auto.scan.otherRequest');
      setScanNotice(null);
      setCode(parsed.code);
      void act(true, parsed.code);
    }
  );
  // External links (for example from a system camera or Android BROWSABLE intent) are
  // untrusted: an approval link only opens the matching request when no other pairing
  // surface is active, and approving it still takes an explicit click.
  useEffect(() => {
    if (!runtime) return undefined;
    return registerE2eePairLinkHandler(
      (url) => {
        const approval = parseAutoPairQr(url);
        if (!approval) return false;
        if (busyRef.current) return true;
        if (!runtime.approveAutomaticPairing) return false;
        const row = requestsRef.current.find(
          (item) => item.id === approval.id && item.phase === 'waiting'
        );
        if (!row) return selectedRef.current !== null || hasVisiblePairingSurface();
        const sameEmpty = selectedRef.current === row.id && codeRef.current === '';
        const idle = selectedRef.current === null && !hasVisiblePairingSurface();
        if (!sameEmpty && !idle) return true;
        inboxRef.current = false;
        setInbox(false);
        selectedRef.current = row.id;
        setSelected(row.id);
        codeOwner.current = row.id;
        codeRef.current = approval.code;
        setCode(approval.code);
        setLinked({ id: row.id, code: approval.code });
        setError(null);
        return true;
      },
      { fallback: true }
    );
  }, [runtime]);
  const requestCount = requests.length;
  const requestsUi = useMemo(
    () => ({
      count: requestCount,
      open: () => setInbox(true),
      review: () => {
        const ready = requestsRef.current.filter((row) => row.phase === 'waiting');
        if (ready.length === 1) setSelected(ready[0]!.id);
        else setInbox(true);
      },
      joinedByCode: () => {
        // The device that just scanned also has an automatic request; closing Settings
        // or the console must not pop it up again.
        for (const row of requestsRef.current)
          if (row.phase === 'waiting' || row.phase === 'preparing') {
            deferred.current.add(row.id);
          }
      },
    }),
    [requestCount]
  );
  return (
    <E2eeDeviceRequestsContext.Provider value={requestsUi}>
      {children}
      <Drawer.Root open={inbox} onOpenChange={setInbox}>
        <Drawer.Content side="end" xstyle={themeStyles.glyph3}>
          <PrivatePairingSurface>
            <Drawer.Title>{t('e2ee.auto.inbox')}</Drawer.Title>
            <Drawer.Description>{t('e2ee.auto.inbox.help')}</Drawer.Description>
            <div {...stylex.props(themeStyles.spaced4)}>
              {requests.map((row) => (
                <div key={row.id} {...stylex.props(themeStyles.panel4)}>
                  <p {...stylex.props(themeStyles.layout)}>{row.deviceName}</p>
                  <p {...stylex.props(themeStyles.hint17)}>{row.workspaceName}</p>
                  <Button
                    xstyle={themeStyles.glyph4}
                    variant="secondary"
                    disabled={row.phase !== 'waiting'}
                    onClick={() => {
                      inboxRef.current = false;
                      setInbox(false);
                      selectedRef.current = row.id;
                      setSelected(row.id);
                    }}
                  >
                    {t(row.phase === 'syncing' ? 'e2ee.auto.confirming' : 'e2ee.auto.review')}
                  </Button>
                </div>
              ))}
            </div>
          </PrivatePairingSurface>
        </Drawer.Content>
      </Drawer.Root>
      <Dialog.Root
        open={Boolean(current || ended)}
        onOpenChange={(open) => {
          if (!open) later();
        }}
      >
        <Dialog.Content
          ref={dialog}
          data-e2ee-pairing-surface=""
          width={440}
          tabIndex={-1}
          xstyle={themeStyles.panel5}
          closeButton={false}
          initialFocus={dialog}
        >
          <PrivatePairingSurface>
            <div {...stylex.props(themeStyles.dialogBody)}>
              {ended && !current && (
                <>
                  <Dialog.Title>{t('e2ee.auto.codeLocked.title')}</Dialog.Title>
                  <Dialog.Description>
                    {t('e2ee.auto.codeLocked.help', { workspace: ended.workspaceName })}
                  </Dialog.Description>
                  <Button xstyle={themeStyles.spaced5} onClick={() => setEnded(null)}>
                    {t('e2ee.auto.codeLocked.ok')}
                  </Button>
                </>
              )}
              {current && (
                <>
                  <div {...stylex.props(themeStyles.row4)}>
                    <span>{t('e2ee.auto.newRequest')}</span>
                    <div {...stylex.props(themeStyles.headerRight)}>
                      <ApprovalExpiry expiresAt={current.expiresAt} inline />
                      <Button variant="ghost" size="small" onClick={later}>
                        {t('e2ee.auto.later')}
                      </Button>
                    </div>
                  </div>
                  <div {...stylex.props(themeStyles.dialogHeader)}>
                    <Dialog.Title>{t('e2ee.auto.approve.title')}</Dialog.Title>
                    <Dialog.Description>{t('e2ee.auto.approve.help')}</Dialog.Description>
                  </div>
                  <div {...stylex.props(themeStyles.infoStrip)}>
                    <div {...stylex.props(themeStyles.infoRow)}>
                      <Smartphone
                        size={14}
                        aria-hidden="true"
                        {...stylex.props(themeStyles.infoIcon)}
                      />
                      <div {...stylex.props(themeStyles.infoMeta)}>
                        <span {...stylex.props(themeStyles.infoPrimary)}>{current.deviceName}</span>
                        <span {...stylex.props(themeStyles.infoSecondary)}>
                          {t('e2ee.auto.deviceNameUnverified')}
                        </span>
                      </div>
                    </div>
                    <div {...stylex.props(themeStyles.infoDivider)} />
                    <div {...stylex.props(themeStyles.infoScope)}>
                      {candidates.length > 1 ? (
                        <ul
                          data-testid="e2ee-approval-workspaces"
                          {...stylex.props(themeStyles.workspaceList)}
                        >
                          {candidates.map((item) => {
                            const own = item.workspaceId === current.workspaceId;
                            return (
                              <li key={item.workspaceId}>
                                <label {...stylex.props(themeStyles.workspaceRow)}>
                                  <Checkbox
                                    checked={own || !excluded.has(item.workspaceId)}
                                    disabled={own || Boolean(busy)}
                                    aria-label={item.name}
                                    data-workspace-id={item.workspaceId}
                                    onCheckedChange={(checked) =>
                                      setExcluded((value) => {
                                        const next = new Set(value);
                                        if (checked) next.delete(item.workspaceId);
                                        else next.add(item.workspaceId);
                                        return next;
                                      })
                                    }
                                  />
                                  <span {...stylex.props(themeStyles.infoWorkspace)}>
                                    {item.name}
                                  </span>
                                  {own && (
                                    <span {...stylex.props(themeStyles.infoSecondary)}>
                                      {t('e2ee.auto.requestedHere')}
                                    </span>
                                  )}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <span {...stylex.props(themeStyles.infoWorkspace)}>
                          {current.workspaceName}
                        </span>
                      )}
                      <span {...stylex.props(themeStyles.infoSecondary)}>
                        {t('e2ee.auto.scope')}
                      </span>
                    </div>
                  </div>
                  {linkedCode ? (
                    <div role="status" data-testid="e2ee-approval-linked">
                      <p {...stylex.props(themeStyles.linkedTitle)}>
                        <CircleCheck size={15} aria-hidden="true" />
                        {t('e2ee.auto.linked.title')}
                      </p>
                      <p {...stylex.props(pairingStyles.code)}>
                        {`${linkedCode.slice(0, 3)} ${linkedCode.slice(3)}`}
                      </p>
                      <p {...stylex.props(themeStyles.hint2)}>{t('e2ee.auto.linked.help')}</p>
                    </div>
                  ) : scanning ? (
                    <div {...stylex.props(themeStyles.layout5)} data-testid="e2ee-approval-scan">
                      <video
                        ref={scanVideo}
                        muted
                        playsInline
                        {...stylex.props(themeStyles.panel6)}
                      />
                      {(scanState === 'denied' || scanState === 'unavailable') && (
                        <p role="alert" {...stylex.props(themeStyles.hint14)}>
                          {t(
                            scanState === 'denied'
                              ? 'e2ee.verify.cameraDenied'
                              : 'e2ee.verify.cameraUnavailable'
                          )}
                        </p>
                      )}
                      <Button
                        xstyle={themeStyles.spaced6}
                        variant="ghost"
                        onClick={() => setScanning(false)}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <form
                      {...stylex.props(themeStyles.codeForm)}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act(true);
                      }}
                    >
                      <label htmlFor="e2ee-approval-code" {...stylex.props(themeStyles.copy6)}>
                        {t('e2ee.auto.enterCode')}
                      </label>
                      <Input
                        id="e2ee-approval-code"
                        data-testid="e2ee-approval-code"
                        size="large"
                        value={code}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="000000"
                        aria-invalid={error?.kind === 'mismatch' || undefined}
                        aria-describedby={error ? 'e2ee-approval-code-error' : undefined}
                        disabled={
                          Boolean(busy) || current.phase !== 'waiting' || error?.kind === 'refused'
                        }
                        onChange={(event) => {
                          // Full-width IME digits (１２３) become ASCII before filtering.
                          setCode(
                            event.target.value.normalize('NFKC').replace(/\D/g, '').slice(0, 6)
                          );
                          if (error?.kind === 'retry') setError(null);
                        }}
                      />
                      {error?.kind === 'mismatch' && (
                        <p
                          id="e2ee-approval-code-error"
                          role="alert"
                          {...stylex.props(themeStyles.copy7)}
                        >
                          {t('e2ee.auto.codeMismatch', { count: error.attemptsLeft })}
                        </p>
                      )}
                      {mobile && cameraSupported() && (
                        <Button
                          variant="link"
                          size="small"
                          data-testid="e2ee-approval-scan-start"
                          xstyle={themeStyles.scanShortcut}
                          disabled={Boolean(busy) || error?.kind === 'refused'}
                          onClick={() => {
                            setScanNotice(null);
                            setScanning(true);
                          }}
                        >
                          <Camera size={14} aria-hidden="true" />
                          {t('e2ee.auto.scanApprove')}
                        </Button>
                      )}
                      {scanNotice && (
                        <p role="status" {...stylex.props(themeStyles.hint14)}>
                          {t(scanNotice)}
                        </p>
                      )}
                    </form>
                  )}
                  <p {...stylex.props(themeStyles.scopeFootnote)}>{t('e2ee.auto.scopeListed')}</p>
                </>
              )}
            </div>
            {current && (
              <div {...stylex.props(themeStyles.dialogFooter)}>
                <div {...stylex.props(themeStyles.column4)}>
                  <Button
                    variant="secondary"
                    tone="destructive"
                    disabled={Boolean(busy) || error?.kind === 'refused'}
                    onClick={() => void act(false)}
                  >
                    {t('e2ee.auto.notMine')}
                  </Button>
                  <Button
                    // Grow only beside "not mine": in the stacked phone layout a
                    // zero flex-basis would override the button height and crush it.
                    xstyle={themeStyles.row5}
                    data-testid="e2ee-approval-authorize"
                    disabled={
                      Boolean(busy) ||
                      current.phase !== 'waiting' ||
                      error?.kind === 'refused' ||
                      !/^\d{6}$/.test(code) ||
                      currentSecondsLeft === 0
                    }
                    onClick={() => void act(true)}
                  >
                    {busy
                      ? t('e2ee.auto.confirming')
                      : candidates.length > 1
                        ? t('e2ee.auto.authorizeSelected', { count: chosenIds.length })
                        : t('e2ee.auto.authorize')}
                  </Button>
                </div>
                {(error?.kind === 'retry' || error?.kind === 'refused') && (
                  <p
                    id="e2ee-approval-code-error"
                    role="alert"
                    {...stylex.props(themeStyles.footerError)}
                  >
                    {t(error.key)}
                  </p>
                )}
                {error?.kind === 'refused' && (
                  <Button variant="secondary" onClick={later}>
                    {t('common.close')}
                  </Button>
                )}
              </div>
            )}
          </PrivatePairingSurface>
        </Dialog.Content>
      </Dialog.Root>
    </E2eeDeviceRequestsContext.Provider>
  );
}

const themeStyles = stylex.create({
  linkedTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: appSpace[2],
    margin: 0,
    fontWeight: 500,
    color: uiColors.label,
  },
  workspaceList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: appSpace[1],
  },
  workspaceRow: { display: 'flex', alignItems: 'center', gap: appSpace[2] },
  scanShortcut: { alignSelf: 'center' },
  hint: {
    marginBlock: appSpace[6],
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
    boxShadow: uiShadow.card,
    backgroundColor: uiColors.elevatedBackground,
    paddingInline: appSpace[4],
    paddingBlock: appSpace[5],
    textAlign: 'center',
  },
  hint2: {
    marginTop: appSpace[2],
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.secondaryLabel,
  },
  glyph: {
    position: 'relative',
    height: '100dvh',
    overflowY: 'auto',
    backgroundColor: uiColors.background,
    paddingInline: appSpace[6],
    paddingBottom: 'max(2rem,env(safe-area-inset-bottom))',
  },
  consentColumn: {
    marginInline: 'auto',
    display: 'flex',
    maxWidth: '24rem',
    flexDirection: 'column',
    paddingTop: appSpace[10],
  },
  column: {
    marginInline: 'auto',
    display: 'flex',
    minHeight: '75dvh',
    maxWidth: '24rem',
    flexDirection: 'column',
    paddingTop: appSpace[10],
    textAlign: 'center',
  },
  copy: { fontSize: uiText.titleSize, lineHeight: 1.375, fontWeight: 600 },
  hint3: {
    marginTop: appSpace[4],
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    color: uiColors.secondaryLabel,
  },
  spaced: { marginTop: appSpace[6] },
  hint4: {
    marginTop: appSpace[5],
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    color: uiColors.secondaryLabel,
  },
  spaced2: { marginTop: appSpace[5] },
  hint5: {
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    color: uiColors.secondaryLabel,
  },
  spaced3: { marginTop: appSpace[3] },
  hint6: {
    marginBottom: appSpace[1],
    marginTop: appSpace[4],
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    color: uiColors.secondaryLabel,
  },
  layout: { fontWeight: 500 },
  copy2: {
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    fontWeight: 500,
  },
  row: {
    marginTop: appSpace[4],
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: appSpace[2],
  },
  panel: {
    aspectRatio: '1',
    width: '100%',
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
    backgroundColor: uiColors.secondaryBackground,
    objectFit: 'cover',
  },
  row2: {
    marginInline: 'auto',
    marginTop: appSpace[6],
    display: 'inline-flex',
    maxWidth: '100%',
    alignItems: 'center',
    gap: appSpace[1.5],
    borderRadius: uiRadius.full,
    cornerShape: uiCorner.round,
    backgroundColor: uiColors.secondaryBackground,
    paddingInline: appSpace[2.5],
    paddingBlock: appSpace[1],
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    textAlign: 'start',
  },
  /** Receiving keys is a wait with nothing to do: the column centres on the transfer. */
  receivingColumn: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 0,
    paddingBottom: appSpace[10],
  },
  receivingArt: { display: 'flex', justifyContent: 'center', marginBottom: appSpace[8] },
  cardArt: { display: 'flex', justifyContent: 'center', marginBottom: appSpace[4] },
  dialogBody: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: appSpace[3],
    paddingTop: '18px',
    paddingInline: '20px',
    paddingBottom: '14px',
  },
  dialogHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: appSpace[1],
  },
  headerRight: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: appSpace[2],
  },
  expiryInline: {
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  infoStrip: {
    display: 'flex',
    flexDirection: 'column',
    gap: appSpace[2],
    paddingBlock: '10px',
    paddingInline: '12px',
    borderRadius: uiRadius.medium,
    cornerShape: uiCorner.shape,
    backgroundColor: uiColors.secondaryBackground,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: uiColors.separator,
  },
  infoRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: appSpace[2],
  },
  infoIcon: {
    flexShrink: 0,
    marginTop: '2px',
    color: uiColors.secondaryLabel,
  },
  infoMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  infoPrimary: {
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    fontWeight: 600,
    color: uiColors.label,
  },
  infoWorkspace: {
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    fontWeight: 600,
    color: uiColors.label,
  },
  infoSecondary: {
    fontSize: uiText.captionSize,
    lineHeight: uiText.captionLeading,
    color: uiColors.secondaryLabel,
  },
  infoDivider: {
    height: '1px',
    backgroundColor: uiColors.separator,
  },
  infoScope: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  tabPanel: {
    paddingTop: appSpace[2],
  },
  codeForm: {
    marginBlock: appSpace[1],
  },
  scopeFootnote: {
    margin: 0,
    fontSize: uiText.captionSize,
    lineHeight: uiText.captionLeading,
    color: uiColors.secondaryLabel,
  },
  dialogFooter: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: appSpace[2],
    paddingBlock: '14px',
    paddingInline: '20px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: uiColors.separator,
    backgroundColor: uiColors.elevatedBackground,
  },
  footerError: {
    margin: 0,
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.destructive,
  },
  column2: {
    marginInline: 'auto',
    marginTop: appSpace[6],
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: appSpace[2],
  },
  panel2: {
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
    backgroundColor: '#fff',
    padding: appSpace[2],
    lineHeight: 1,
  },
  hint8: {
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.secondaryLabel,
  },
  hint9: {
    marginTop: appSpace[1],
    fontSize: uiText.subheadlineSize,
    lineHeight: 1.625,
    color: uiColors.secondaryLabel,
  },
  hint10: {
    marginBlock: appSpace[6],
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
    boxShadow: uiShadow.card,
    backgroundColor: uiColors.elevatedBackground,
    paddingInline: appSpace[4],
    paddingBlock: appSpace[5],
    textAlign: 'start',
  },
  hint11: {
    marginTop: appSpace[2],
    fontSize: uiText.subheadlineSize,
    lineHeight: 1.625,
    color: uiColors.secondaryLabel,
  },
  row3: {
    display: { default: 'inline-flex', '::-webkit-details-marker': 'none' },
    cursor: 'pointer',
    listStyleType: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    gap: appSpace[1.5],
  },
  copy3: { marginTop: appSpace[3], textAlign: 'start', lineHeight: 1.625 },
  hint14: {
    marginTop: appSpace[2],
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    color: uiColors.secondaryLabel,
  },
  hint15: {
    marginTop: 'auto',
    paddingTop: appSpace[10],
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.secondaryLabel,
  },
  hint16: {
    borderRadius: uiRadius.full,
    cornerShape: uiCorner.round,
    backgroundColor: uiColors.secondaryBackground,
    paddingInline: appSpace[1.5],
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
  },
  glyph3: { width: '100%', maxWidth: { default: null, '@media (min-width: 640px)': '24rem' } },
  spaced4: {
    marginTop: appSpace[6],
    display: 'flex',
    flexDirection: 'column',
    rowGap: appSpace[3],
  },
  panel4: {
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
    boxShadow: uiShadow.card,
    backgroundColor: uiColors.elevatedBackground,
    padding: appSpace[4],
  },
  hint17: {
    marginTop: appSpace[1],
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    color: uiColors.secondaryLabel,
  },
  glyph4: { marginTop: appSpace[4], width: '100%' },
  panel5: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    padding: 0,
    maxHeight: '90dvh',
    width: '100%',
    maxWidth: { default: 'calc(100vw - 2rem)', '@media (min-width: 640px)': '28rem' },
    overflow: 'hidden',
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
  },
  copy4: { fontSize: uiText.titleSize, lineHeight: 1.375 },
  spaced5: { marginTop: appSpace[4] },
  row4: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.secondaryLabel,
  },
  copy5: {
    marginTop: appSpace[2],
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    fontWeight: 500,
  },
  spaced6: { marginTop: appSpace[2] },
  layout5: { marginBlock: appSpace[5] },
  panel6: {
    aspectRatio: '1',
    width: '100%',
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
    backgroundColor: uiColors.secondaryBackground,
    objectFit: 'cover',
  },
  copy6: {
    marginBottom: appSpace[2],
    display: 'block',
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
  },
  copy7: {
    marginTop: appSpace[2],
    fontSize: uiText.subheadlineSize,
    lineHeight: uiText.subheadlineLeading,
    color: uiColors.destructive,
  },
  panel7: {
    borderRadius: uiRadius.large,
    cornerShape: uiCorner.shape,
    boxShadow: uiShadow.card,
    backgroundColor: uiColors.elevatedBackground,
    padding: appSpace[4],
  },
  hint18: {
    marginTop: appSpace[1],
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.secondaryLabel,
  },
  column4: {
    display: 'flex',
    flexDirection: { default: 'column-reverse', '@media (min-width: 640px)': 'row' },
    gap: appSpace[2],
  },
  row5: { flex: { default: null, '@media (min-width: 640px)': '1 1 0%' } },
  hint19: {
    textAlign: 'center',
    fontSize: uiText.footnoteSize,
    lineHeight: uiText.footnoteLeading,
    color: uiColors.secondaryLabel,
  },
});

const pairingStyles = stylex.create({
  code: {
    fontFamily: 'var(--font-mono)',
    fontSize: '2.25rem',
    lineHeight: '2.5rem',
    fontWeight: 600,
    letterSpacing: '0.15em',
    fontVariantNumeric: 'tabular-nums',
  },
});
