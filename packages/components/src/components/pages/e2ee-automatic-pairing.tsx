import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, ChevronDown, ChevronLeft, CircleCheck, QrCode, Smartphone } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { accountPairingErrorCode } from '@lody/platform';
import type {
  E2eeAutomaticPairingReview,
  E2eeAutomaticPairingState,
  E2eeAccountPairingRequestState,
  E2eeWorkspaceRuntime,
} from '@lody/platform';
import { Dialog } from '@/ui/dialog';
import { Drawer } from '@lody/ui/drawer';
import { E2eeAccountPairingRequest, failureKey, localCodeError } from './e2ee-account-pairing';
import {
  autoPairQrPayload,
  E2eeInstantQrApprove,
  parseAutoPairQr,
  PrivatePairingSurface,
  supportsInstantQr,
  usePairingPrivacy,
} from './e2ee-instant-qr';
import { LedgerQrCode, useQrCamera } from './e2ee-ledger-verification';
import { useIsMobile } from '@/hooks/use-mobile';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { E2eeLostAllRecovery, type E2eeLostAllRecoveryProps } from './e2ee-lost-all-recovery';

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
/** The new device's poll for its QR join; the approving device signs within a second. */
const QR_JOIN_POLL_MS = 800;
const cameraSupported = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';

/** The first service or host code carried by a failure, through wrappers. */
function carriedCode(cause: unknown, depth = 0): string | null {
  if (!cause || typeof cause !== 'object' || depth > 3) return null;
  const record = cause as { code?: unknown; data?: unknown; message?: unknown; cause?: unknown };
  if (typeof record.code === 'string') return record.code;
  const data = record.data as { code?: unknown } | null | undefined;
  if (data && typeof data === 'object' && typeof data.code === 'string') return data.code;
  if (typeof record.message === 'string' && /^e2ee_[\w-]+$/.test(record.message))
    return record.message;
  return carriedCode(record.cause, depth + 1);
}
/** Only an outage retries quietly; a refusal says what went wrong instead of blaming the
 * connection. */
export function automaticPairingErrorKey(cause: unknown): string {
  const known = accountPairingErrorCode(cause);
  if (known) return `e2ee.accountPair.error.${known}`;
  const code = carriedCode(cause)?.replace(/^e2ee_/, '') ?? null;
  if (code === null || /^(?:network|closed|offline|timeout|unavailable)$/.test(code))
    return 'e2ee.auto.connectionRetry';
  if (/pairing-unavailable|account_pairing_disabled/.test(code))
    return 'e2ee.accountPair.error.pairing-unavailable';
  return 'e2ee.accountPair.error.failed';
}
const ComparisonCode = ({ code, hint }: { code: string; hint: string }) => {
  const { t } = useTranslation();
  return (
    <div className="my-6 rounded-2xl border bg-muted/40 px-4 py-5 text-center">
      <p
        className="font-mono text-4xl font-semibold tracking-[0.15em] tabular-nums"
        aria-live="polite"
      >
        {`${code.slice(0, 3)} ${code.slice(3)}`}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{t(hint)}</p>
    </div>
  );
};
/** New native device: open once, retain its request, then progress without manual checks. */
export function E2eeAutomaticPairingPage({
  runtime,
  workspaceId,
  onJoined,
  onBack,
  onManual,
  keyFailure,
  onRetryKeys,
  lostAll,
}: {
  runtime: E2eeWorkspaceRuntime;
  workspaceId: string;
  onJoined: () => void;
  onBack: () => void;
  onManual?: () => void;
  keyFailure?: boolean;
  onRetryKeys?: () => void;
  /** Present where this host can restore from a backup (desktop with recovery on). */
  lostAll?: Omit<E2eeLostAllRecoveryProps, 'workspaceId'>;
}) {
  usePairingPrivacy();
  const { t, i18n } = useTranslation();
  const [lostAllOpen, setLostAllOpen] = useState(false);
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
  // Scanning another device's code joins through that code instead; while it runs the
  // automatic request is left alone, so neither flow cancels the other.
  const [qr, setQr] = useState<'idle' | 'scanning' | 'joining' | 'joined'>('idle');
  const [qrError, setQrError] = useState<string | null>(null);
  const qrPaused = useRef(false);
  qrPaused.current = qr === 'joining' || qr === 'joined';
  // Phones scan and computers show: a laptop webcam is never the primary path.
  const mobile = useIsMobile();
  const qrSupported =
    mobile &&
    Boolean(runtime.requestAccountPairing && runtime.accountPairingRequest) &&
    cameraSupported();
  useEffect(() => {
    if (!canStart) return undefined;
    let alive = true,
      running = false;
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
      if (!alive || running || qrPaused.current) return;
      running = true;
      try {
        const retained = await runtime.automaticPairingState!(workspaceId);
        if (!alive) return;
        accept(retained ?? (await runtime.startAutomaticPairing!(workspaceId)));
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
    return () => {
      alive = false;
      unsubscribe?.();
      clearInterval(timer);
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
  const finishQrJoin = () => {
    setQr('joined');
    // Only now is the automatic request redundant; ending it earlier would close the
    // other device's dialog while it is still signing for the scanned code.
    void runtime.cancelAutomaticPairing?.(workspaceId).catch(() => undefined);
    if (!completed.current) {
      completed.current = true;
      admitted.current = true;
      joinedRef.current();
    }
  };
  const qrJoined = (next: E2eeAccountPairingRequestState | null) =>
    next?.status === 'joined' ||
    Boolean(
      next?.workspaces.some((item) => item.workspaceId === workspaceId && item.state === 'joined')
    );
  const joinWithCode = async (pairingString: string) => {
    const owner = ownerRef.current;
    setQrError(null);
    setQr('joining');
    try {
      // Without `preserveExisting` the host replaces its retained request atomically,
      // leaving the automatic discovery row open until this join settles.
      const next = await runtime.requestAccountPairing!({ pairingString });
      if (!sameOwner(owner)) return;
      if (qrJoined(next)) finishQrJoin();
    } catch (cause) {
      if (!sameOwner(owner)) return;
      setQr('idle');
      setQrError(failureKey(cause));
    }
  };
  const { video: qrVideo, state: cameraState } = useQrCamera(qr === 'scanning', (scanned) => {
    // The local check wipes the decoded bytes; the host parses the code again.
    if (localCodeError(scanned)) {
      setQr('idle');
      setQrError('e2ee.instantQr.notPairingCode');
      return;
    }
    void joinWithCode(scanned.trim());
  });
  useEffect(() => {
    if (qr !== 'joining' || !runtime.accountPairingRequest) return undefined;
    let alive = true,
      running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void runtime
        .accountPairingRequest!()
        .then((next) => {
          if (!alive) return;
          if (qrJoined(next)) finishQrJoin();
          else if (!next || next.status === 'declined' || next.status === 'expired') {
            setQr('idle');
            setQrError(
              `e2ee.accountPair.error.${next?.status === 'expired' ? 'pairing-expired' : 'failed'}`
            );
          }
        })
        .catch(() => {
          // A failed read keeps the same scanned request; the next poll asks again.
        })
        .finally(() => {
          running = false;
        });
    }, QR_JOIN_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // The join belongs to this page's runtime and workspace; callbacks read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr, runtime, workspaceId]);
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
  const cancel = async (manual = false) => {
    const owner = ownerRef.current;
    if (busy) return;
    setBusy(true);
    try {
      await runtime.cancelAutomaticPairing!(workspaceId);
      if (sameOwner(owner)) {
        if (manual) onManual?.();
        else onBack();
      }
    } catch (cause) {
      if (sameOwner(owner))
        setError(`e2ee.accountPair.error.${accountPairingErrorCode(cause) ?? 'failed'}`);
    } finally {
      if (sameOwner(owner)) setBusy(false);
    }
  };
  if (!canStart)
    return (
      <main className="h-dvh overflow-y-auto bg-background px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('e2ee.control.back')}
        </Button>
        <E2eeAccountPairingRequest
          key={workspaceId}
          runtime={runtime}
          workspaceId={workspaceId}
          autoStart={false}
          onJoined={onJoined}
          onRequestApproval={() => setApprovalChoice({ runtime, workspaceId })}
        />
      </main>
    );
  const formatTime = (value: number) =>
    new Intl.DateTimeFormat(toIntlLocaleOrEn(i18n?.language), {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  const recovered = () => {
    setLostAllOpen(false);
    // Reached only when this workspace's own restore committed: its pending request is
    // no longer needed. Another workspace's success keeps this request.
    void runtime.cancelAutomaticPairing?.(workspaceId).catch(() => undefined);
    lostAll?.onRecovered();
  };
  const receiving = state?.phase === 'syncing' || state?.phase === 'joined' || qr === 'joined';
  const terminal =
    !receiving && state && ['declined', 'expired', 'cancelled'].includes(state.phase);
  const scanButton = (label: string) =>
    qrSupported && (
      <Button
        className="mt-5 w-full"
        size="large"
        disabled={busy}
        onClick={() => {
          setQrError(null);
          setQr('scanning');
        }}
      >
        <Camera size={18} aria-hidden="true" />
        {t(label)}
      </Button>
    );
  return (
    <main className="h-dvh overflow-y-auto bg-background px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]">
      <Button variant="ghost" onClick={onBack}>
        <ChevronLeft size={16} />
        {t('e2ee.control.back')}
      </Button>
      <section className="mx-auto flex min-h-[75dvh] max-w-sm flex-col pt-10 text-center">
        <h1 className="text-2xl font-semibold leading-snug">
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
            <p className="mt-4 text-sm text-muted-foreground">
              {t(`e2ee.auto.${state.phase}.help`)}
            </p>
            <Button className="mt-6" disabled={busy} onClick={() => void restart()}>
              {t('e2ee.auto.restart')}
            </Button>
          </>
        ) : receiving ? (
          <>
            <p className="mt-5 text-sm text-muted-foreground">{t('e2ee.auto.syncing.help')}</p>
            {keyFailure && (
              <div className="mt-5">
                <p role="alert" className="text-sm text-muted-foreground">
                  {t('e2ee.accountPair.request.keyFailed')}
                </p>
                <Button className="mt-3" variant="secondary" onClick={onRetryKeys}>
                  {t('e2ee.accountPair.request.keyRetry')}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="mb-1 mt-4 text-sm text-muted-foreground">{t('e2ee.auto.requesting')}</p>
            <p className="font-medium">{state?.workspaceName}</p>
            {qr === 'joining' ? (
              <p
                role="status"
                data-testid="e2ee-qr-joining"
                className="my-8 text-sm text-muted-foreground"
              >
                {t('e2ee.instantQr.scannedJoining')}
              </p>
            ) : qr === 'scanning' ? (
              <div className="my-6" data-testid="e2ee-qr-viewfinder">
                <video
                  ref={qrVideo}
                  muted
                  playsInline
                  className="aspect-square w-full rounded-2xl bg-muted object-cover"
                />
                {cameraState === 'unavailable' && (
                  <p role="alert" className="mt-3 text-sm text-muted-foreground">
                    {t('e2ee.verify.cameraUnavailable')}
                  </p>
                )}
                <Button className="mt-3" variant="ghost" onClick={() => setQr('idle')}>
                  {t('common.cancel')}
                </Button>
              </div>
            ) : state?.comparisonCode ? (
              <>
                <p
                  role="status"
                  className="mx-auto mt-6 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm"
                >
                  <CircleCheck size={15} aria-hidden="true" />
                  {t('e2ee.auto.prompted')}
                </p>
                {scanButton('e2ee.auto.scanPrompt')}
                {!mobile && (
                  <div
                    data-testid="e2ee-auto-pair-qr"
                    className="mx-auto mt-6 flex flex-col items-center gap-2"
                  >
                    <div className="rounded-xl bg-white p-2 leading-none">
                      <LedgerQrCode
                        payload={autoPairQrPayload(state.id, state.comparisonCode)}
                        size={168}
                        label={t('e2ee.auto.desktopQr.label')}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">{t('e2ee.auto.desktopQr.help')}</p>
                  </div>
                )}
                <ComparisonCode
                  code={state.comparisonCode}
                  hint={mobile ? 'e2ee.auto.showCode' : 'e2ee.auto.showCode.desktop'}
                />
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {t('e2ee.auto.waiting.help')}
                </p>
              </>
            ) : (
              <div
                data-testid="e2ee-awaiting-device"
                className="my-6 rounded-2xl border bg-muted/40 px-4 py-5 text-left"
              >
                <p role="status" className="text-sm font-medium">
                  {t('e2ee.auto.awaiting.title')}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {t(mobile ? 'e2ee.auto.awaiting.help' : 'e2ee.auto.awaiting.desktopHelp')}
                </p>
                {scanButton('e2ee.auto.scanJoin')}
                {!mobile && onManual && (
                  <Button
                    className="mt-3"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void cancel(true)}
                  >
                    {t('e2ee.auto.offline')}
                  </Button>
                )}
                {qrSupported && (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    <QrCode size={12} aria-hidden="true" className="mr-1 inline" />
                    {t('e2ee.auto.scanJoin.hint')}
                  </p>
                )}
              </div>
            )}
            {qrError && (
              <p role="alert" className="mb-3 text-sm text-muted-foreground">
                {t(qrError)}
              </p>
            )}
            <details className="mt-4 text-sm text-muted-foreground">
              <summary className="inline-flex cursor-pointer list-none items-center justify-center gap-1.5 [&::-webkit-details-marker]:hidden">
                {t('e2ee.auto.noRequest')}
                <ChevronDown size={14} />
              </summary>
              <p className="mt-3 text-left leading-relaxed">{t('e2ee.auto.noRequest.help')}</p>
              <Button variant="link" disabled={busy} onClick={() => void restart(true)}>
                {t('e2ee.auto.changeDevice')}
              </Button>
              {onManual && (
                <Button variant="link" disabled={busy} onClick={() => void cancel(true)}>
                  {t('e2ee.auto.manual')}
                </Button>
              )}
            </details>
            <details
              className="mt-2 text-sm text-muted-foreground"
              data-testid="e2ee-lost-all-entry"
            >
              <summary className="inline-flex cursor-pointer list-none items-center justify-center gap-1.5 [&::-webkit-details-marker]:hidden">
                {t('e2ee.auto.noOtherDevice')}
                <ChevronDown size={14} />
              </summary>
              <p className="mt-3 text-left leading-relaxed">
                {t(lostAll ? 'e2ee.auto.noOtherDevice.help' : 'e2ee.auto.noOtherDevice.elsewhere')}
              </p>
              {lostAll && (
                <Button variant="link" disabled={busy} onClick={() => setLostAllOpen(true)}>
                  {t('e2ee.auto.noOtherDevice.restore')}
                </Button>
              )}
            </details>
          </>
        )}
        {error && (
          <p role="alert" className="mt-5 text-sm text-muted-foreground">
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
          <div className="mt-auto pt-10 text-xs text-muted-foreground">
            {state && (
              <p>
                {secondsLeft !== null && secondsLeft < 60 * 60
                  ? t('e2ee.auto.expiresIn', { time: clock(secondsLeft) })
                  : t('e2ee.auto.expiry', { time: formatTime(state.expiresAt) })}
              </p>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>
              {t('e2ee.auto.cancel')}
            </Button>
          </div>
        )}
      </section>
      {lostAll && (
        <Dialog.Root open={lostAllOpen} onOpenChange={setLostAllOpen}>
          <Dialog.Content width={480} className="max-h-[90dvh] overflow-y-auto">
            <Dialog.Title>{t('e2ee.lostAll.title')}</Dialog.Title>
            <E2eeLostAllRecovery
              workspaceId={workspaceId}
              passkeyAvailable={lostAll.passkeyAvailable}
              restore={lostAll.restore}
              onRecovered={recovered}
            />
          </Dialog.Content>
        </Dialog.Root>
      )}
    </main>
  );
}

function ApprovalExpiry({ expiresAt }: { expiresAt: number }) {
  const { t } = useTranslation();
  const seconds = useSecondsLeft(expiresAt);
  if (seconds === null || seconds >= 60 * 60) return null;
  return (
    <p data-testid="e2ee-approval-expiry" className="text-xs text-muted-foreground">
      {seconds === 0
        ? t('e2ee.auto.expired.short')
        : t('e2ee.auto.expiresIn', { time: clock(seconds) })}
    </p>
  );
}

type RequestsUi = { count: number; open: () => void };
const RequestsContext = createContext<RequestsUi | null>(null);
/** Persistent application chrome entry for requests a person chose to handle later. */
export function E2eeDeviceRequestsButton({ className }: { className?: string }) {
  const ui = useContext(RequestsContext);
  const { t } = useTranslation();
  if (!ui?.count) return null;
  return (
    <Button variant="secondary" className={className} onClick={ui.open}>
      <Smartphone size={15} />
      {t('e2ee.auto.inbox')}
      <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{ui.count}</span>
    </Button>
  );
}
/** One account's application-level inbox, shared by desktop and mobile chrome. */
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
    { kind: 'retry' } | { kind: 'mismatch'; attemptsLeft: number } | null
  >(null);
  const [code, setCode] = useState('');
  // The typed code belongs to one request. A poll that briefly omits it closes the dialog,
  // but reopening the same request keeps the digits and the attempts-left notice.
  const codeOwner = useRef<string | null>(null);
  /** A request this device ended after too many wrong codes; shown until dismissed. */
  const [ended, setEnded] = useState<E2eeAutomaticPairingReview | null>(null);
  const deferred = useRef(new Set<string>());
  const actionOwner = useRef({ runtime });
  if (actionOwner.current.runtime !== runtime) actionOwner.current = { runtime };
  useEffect(
    () => () => {
      actionOwner.current = { ...actionOwner.current };
    },
    []
  );
  /** The request whose dialog revealed a one-time QR code. The code stays until it is
   * used or dismissed, even if that request leaves the list mid-scan. */
  const [qrFor, setQrFor] = useState<string | null>(null);
  const qrSupported = supportsInstantQr(runtime);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const qrForRef = useRef(qrFor);
  qrForRef.current = qrFor;
  const dialog = useRef<HTMLDivElement>(null);
  // A phone approves by scanning the new device's screen; a computer types its code.
  const mobile = useIsMobile();
  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  useEffect(() => {
    let alive = true,
      running = false;
    setQrFor(null);
    setRequests([]);
    setBusy(null);
    setError(null);
    setCode('');
    codeOwner.current = null;
    setEnded(null);
    setSelected(null);
    deferred.current.clear();
    if (!runtime?.pendingAutomaticPairing) return;
    const tick = async () => {
      if (!alive || running) return;
      running = true;
      setRequests((previous) => previous.filter((row) => row.expiresAt > Date.now()));
      try {
        const rows = await runtime.pendingAutomaticPairing!();
        if (!alive) return;
        setRequests(rows);
        const ids = new Set(rows.map((row) => row.id));
        for (const id of deferred.current) if (!ids.has(id)) deferred.current.delete(id);
        if (selectedRef.current && !ids.has(selectedRef.current)) setSelected(null);
        // A visible window presents even without keyboard focus (another app or a
        // second screen); a hidden one leaves the request to the system notification.
        if (
          !selectedRef.current &&
          !inboxRef.current &&
          !qrForRef.current &&
          document.visibilityState === 'visible' &&
          !document.querySelector('[role="dialog"]:not([hidden])')
        ) {
          const next = rows.find((row) => row.phase === 'waiting' && !deferred.current.has(row.id));
          if (next) setSelected(next.id);
        }
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
    const timer = setInterval(() => void tick(), POLL_MS);
    // Restoring a minimized window presents a waiting request at once.
    const wake = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      alive = false;
      unsubscribe?.();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [runtime]);
  const current = requests.find((row) => row.id === selected);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(dismissTimer.current), []);
  const qrJoined = (id: string) => {
    clearTimeout(dismissTimer.current);
    // Show the result briefly, then close without resurfacing the request it answered.
    dismissTimer.current = setTimeout(() => {
      if (qrForRef.current !== id) return;
      deferred.current.add(id);
      if (selectedRef.current === id) setSelected(null);
      setQrFor(null);
    }, 1200);
  };
  useEffect(() => {
    if (!selected || selected === codeOwner.current) return;
    codeOwner.current = selected;
    setCode('');
    setError(null);
  }, [selected]);
  const { video: scanVideo, state: scanState } = useQrCamera(
    scanning && Boolean(current),
    (scanned) => {
      setScanning(false);
      const parsed = parseAutoPairQr(scanned);
      // Another request's code is not a wrong entry: nothing is sent, no attempt is used.
      if (!parsed) return setScanNotice('e2ee.auto.scan.unreadable');
      if (!current || parsed.id !== current.id) return setScanNotice('e2ee.auto.scan.otherRequest');
      setScanNotice(null);
      setCode(parsed.code);
      void act(true, parsed.code);
    }
  );
  useEffect(() => {
    setScanning(false);
    setScanNotice(null);
  }, [selected]);
  const later = () => {
    if (selected) deferred.current.add(selected);
    clearTimeout(dismissTimer.current);
    setQrFor(null);
    setSelected(null);
    setEnded(null);
    setError(null);
  };
  const act = async (approve: boolean, entered = code) => {
    if (!current || busy || !runtime) return;
    if (approve && !/^\d{6}$/.test(entered)) return;
    const owner = actionOwner.current;
    setBusy(current.id);
    setError(null);
    try {
      if (approve) await runtime.approveAutomaticPairing!(current.id, entered);
      else await runtime.declineAutomaticPairing!(current.id);
      if (owner !== actionOwner.current) return;
      deferred.current.add(current.id);
      setSelected(null);
      setQrFor(null);
      if (!approve) setRequests((rows) => rows.filter((row) => row.id !== current.id));
    } catch (cause) {
      if (owner !== actionOwner.current) return;
      const refusal = accountPairingErrorCode(cause);
      if (refusal === 'pairing-code-locked') {
        deferred.current.add(current.id);
        setRequests((rows) => rows.filter((row) => row.id !== current.id));
        setSelected(null);
        setQrFor(null);
        setEnded(current);
      } else if (refusal === 'pairing-code-mismatch') {
        const left = (cause as { attemptsLeft?: unknown }).attemptsLeft;
        setCode('');
        setError({ kind: 'mismatch', attemptsLeft: typeof left === 'number' ? left : 1 });
      } else setError({ kind: 'retry' });
    } finally {
      if (owner === actionOwner.current) setBusy(null);
    }
  };
  // Shows a one-time code that another phone scans to join; revealed by a click, never
  // by an incoming request on its own.
  const qrSlot = qrSupported && runtime && (qrFor || current) && (
    <div className="my-5 rounded-xl border p-4" data-testid="e2ee-approval-qr">
                {qrFor ? (
                  <E2eeInstantQrApprove
                    key={qrFor}
                    runtime={runtime}
                    onJoined={() => qrJoined(qrFor)}
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-center">
                    <Button
                      data-testid="e2ee-approval-show-qr"
                      variant={mobile ? 'ghost' : 'primary'}
                      disabled={Boolean(busy)}
                      onClick={() => current && setQrFor(current.id)}
                    >
                      <QrCode size={16} aria-hidden="true" />
                      {t(mobile ? 'e2ee.auto.showQr.mobile' : 'e2ee.auto.showQr')}
                    </Button>
                    <p className="text-xs text-muted-foreground">{t('e2ee.auto.showQr.help')}</p>
                  </div>
                )}
              </div>
  );
  return (
    <RequestsContext.Provider value={{ count: requests.length, open: () => setInbox(true) }}>
      {children}
      <Drawer.Root open={inbox} onOpenChange={setInbox}>
        <Drawer.Content side="end" className="w-full sm:max-w-sm">
          <PrivatePairingSurface>
            <Drawer.Title>{t('e2ee.auto.inbox')}</Drawer.Title>
            <Drawer.Description>{t('e2ee.auto.inbox.help')}</Drawer.Description>
            <div className="mt-6 space-y-3">
              {requests.map((row) => (
                <div key={row.id} className="rounded-xl border p-4">
                  <p className="font-medium">{row.deviceName}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{row.workspaceName}</p>
                  <Button
                    className="mt-4 w-full"
                    variant="secondary"
                    disabled={row.phase !== 'waiting'}
                    onClick={() => {
                      setInbox(false);
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
        open={Boolean(current || ended || qrFor)}
        onOpenChange={(open) => {
          if (!open) later();
        }}
      >
        <Dialog.Content
          ref={dialog}
          width={440}
          tabIndex={-1}
          className="max-h-[90dvh] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl sm:max-w-md"
          closeButton={false}
          initialFocus={dialog}
        >
          <PrivatePairingSurface>
            {ended && !current && !qrFor && (
              <>
                <Dialog.Title className="text-2xl leading-snug">
                  {t('e2ee.auto.codeLocked.title')}
                </Dialog.Title>
                <Dialog.Description>
                  {t('e2ee.auto.codeLocked.help', { workspace: ended.workspaceName })}
                </Dialog.Description>
                <Button className="mt-4" onClick={() => setEnded(null)}>
                  {t('e2ee.auto.codeLocked.ok')}
                </Button>
              </>
            )}
            {current && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('e2ee.auto.newRequest')}</span>
                <Button variant="ghost" onClick={later}>
                  {t('e2ee.auto.later')}
                </Button>
              </div>
            )}
            {current ? (
              <>
                <Dialog.Title className="text-2xl leading-snug">
                  {t('e2ee.auto.approve.title')}
                </Dialog.Title>
                <Dialog.Description>{t('e2ee.auto.approve.help')}</Dialog.Description>
                <p className="mt-2 text-sm font-medium">{current.deviceName}</p>
                <p className="text-xs text-muted-foreground">
                  {t('e2ee.auto.deviceNameUnverified')}
                </p>
              </>
            ) : (
              qrFor && (
                <>
                  <Dialog.Title className="text-2xl leading-snug">
                    {t('e2ee.instantQr.title')}
                  </Dialog.Title>
                  <Button className="mt-2" variant="ghost" onClick={later}>
                    {t('common.close')}
                  </Button>
                </>
              )
            )}
            {/* Fixed slots, so the code survives its request leaving the list. */}
            {!mobile && qrSlot}
            {mobile && current && cameraSupported() && (
              <div className="my-5" data-testid="e2ee-approval-scan">
                {scanning ? (
                  <>
                    <video
                      ref={scanVideo}
                      muted
                      playsInline
                      className="aspect-square w-full rounded-xl bg-muted object-cover"
                    />
                    {scanState === 'unavailable' && (
                      <p role="alert" className="mt-2 text-sm text-muted-foreground">
                        {t('e2ee.verify.cameraUnavailable')}
                      </p>
                    )}
                    <Button className="mt-2" variant="ghost" onClick={() => setScanning(false)}>
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <Button
                    className="w-full"
                    size="large"
                    data-testid="e2ee-approval-scan-start"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setScanNotice(null);
                      setScanning(true);
                    }}
                  >
                    <Camera size={18} aria-hidden="true" />
                    {t('e2ee.auto.scanApprove')}
                  </Button>
                )}
                {scanNotice && (
                  <p role="status" className="mt-2 text-sm text-muted-foreground">
                    {t(scanNotice)}
                  </p>
                )}
              </div>
            )}
            {current && (
              <>
                {(mobile ? cameraSupported() : qrSupported) && (
                  <p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                    {t(mobile ? 'e2ee.auto.orCode.mobile' : 'e2ee.auto.orCode')}
                  </p>
                )}
                <form
                  className="my-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(true);
                  }}
                >
                  <label htmlFor="e2ee-approval-code" className="mb-2 block text-sm">
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
                    disabled={Boolean(busy)}
                    onChange={(event) => {
                      // Full-width IME digits (１２３) become ASCII before filtering.
                      setCode(event.target.value.normalize('NFKC').replace(/\D/g, '').slice(0, 6));
                      if (error?.kind === 'retry') setError(null);
                    }}
                  />
                  {error?.kind === 'mismatch' && (
                    <p
                      id="e2ee-approval-code-error"
                      role="alert"
                      className="mt-2 text-sm text-destructive"
                    >
                      {t('e2ee.auto.codeMismatch', { count: error.attemptsLeft })}
                    </p>
                  )}
                </form>
                <div className="rounded-xl border bg-muted/30 p-4">
                  <p className="font-medium">{current.workspaceName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('e2ee.auto.scope')}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('e2ee.auto.currentWorkspaceOnly')}
                </p>
                <ApprovalExpiry expiresAt={current.expiresAt} />
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="secondary"
                    className="border border-destructive/20 bg-destructive/10 text-destructive hover:bg-destructive/15"
                    disabled={Boolean(busy)}
                    onClick={() => void act(false)}
                  >
                    {t('e2ee.auto.notMine')}
                  </Button>
                  <Button
                    className="flex-1"
                    data-testid="e2ee-approval-authorize"
                    disabled={
                      Boolean(busy) || !/^\d{6}$/.test(code) || current.expiresAt <= Date.now()
                    }
                    onClick={() => void act(true)}
                  >
                    {t(busy ? 'e2ee.auto.confirming' : 'e2ee.auto.authorize')}
                  </Button>
                </div>
                {error?.kind === 'retry' && (
                  <p
                    id="e2ee-approval-code-error"
                    role="alert"
                    className="text-sm text-muted-foreground"
                  >
                    {t('e2ee.auto.approvalRetry')}
                  </p>
                )}
                <p className="text-center text-xs text-muted-foreground">
                  {t('e2ee.auto.laterHint')}
                </p>
              </>
            )}
            {mobile && qrSlot}
          </PrivatePairingSurface>
        </Dialog.Content>
      </Dialog.Root>
    </RequestsContext.Provider>
  );
}
