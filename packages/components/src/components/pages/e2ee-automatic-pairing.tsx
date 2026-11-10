import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronLeft, Smartphone } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { accountPairingErrorCode } from '@lody/platform';
import type {
  E2eeAutomaticPairingReview,
  E2eeAutomaticPairingState,
  E2eeAccountPairingRequestState,
  E2eeWorkspaceRuntime,
} from '@lody/platform';
import { Dialog } from '@/ui/dialog';
import { Drawer } from '@lody/ui/drawer';
import { E2eeAccountPairingRequest } from './e2ee-account-pairing';
import { holdPrivateTelemetrySurface } from '@/lib/posthog-privacy';
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

function usePairingPrivacy() {
  useLayoutEffect(() => {
    const release = holdPrivateTelemetrySurface();
    // Layout cleanup precedes host removal. Restart recording only after the
    // commit has removed the private DOM, including a portal's exit transition.
    return () => {
      queueMicrotask(release);
    };
  }, []);
}
function PrivatePairingSurface({ children }: { children: ReactNode }) {
  usePairingPrivacy();
  return <>{children}</>;
}

const POLL_MS = 2000;
const ComparisonCode = ({ code }: { code: string | null }) => {
  const { t } = useTranslation();
  return (
    <div className="my-6 rounded-2xl border bg-muted/40 px-4 py-5 text-center">
      <p className="mb-2 text-xs text-muted-foreground">{t('e2ee.auto.compare')}</p>
      <p
        className="font-mono text-4xl font-semibold tracking-[0.15em] tabular-nums"
        aria-live="polite"
      >
        {code ? `${code.slice(0, 3)} ${code.slice(3)}` : '··· ···'}
      </p>
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
      if (!alive || running) return;
      running = true;
      try {
        const retained = await runtime.automaticPairingState!(workspaceId);
        if (!alive) return;
        accept(retained ?? (await runtime.startAutomaticPairing!(workspaceId)));
      } catch (cause) {
        if (alive) {
          const code = accountPairingErrorCode(cause);
          setError(code ? `e2ee.accountPair.error.${code}` : 'e2ee.auto.connectionRetry');
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
  const receiving = state?.phase === 'syncing' || state?.phase === 'joined';
  const terminal = state && ['declined', 'expired', 'cancelled'].includes(state.phase);
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
            <ComparisonCode code={state?.comparisonCode ?? null} />
            {!state?.comparisonCode && (
              <p role="status" className="text-xs text-muted-foreground">
                {t('e2ee.auto.preparing')}
              </p>
            )}
            {state?.comparisonCode && (
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {t('e2ee.auto.waiting.help')}
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
  const [error, setError] = useState(false);
  const deferred = useRef(new Set<string>());
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
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true,
      running = false;
    setRequests([]);
    setBusy(null);
    setError(false);
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
        if (
          !selectedRef.current &&
          !inboxRef.current &&
          document.visibilityState === 'visible' &&
          document.hasFocus() &&
          !document.querySelector('[role="dialog"]:not([hidden])')
        ) {
          const next = rows.find(
            (row) => row.phase === 'waiting' && row.comparisonCode && !deferred.current.has(row.id)
          );
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
    return () => {
      alive = false;
      unsubscribe?.();
      clearInterval(timer);
    };
  }, [runtime]);
  const current = requests.find((row) => row.id === selected);
  const later = () => {
    if (selected) deferred.current.add(selected);
    setSelected(null);
    setError(false);
  };
  const act = async (approve: boolean) => {
    if (!current || busy || !runtime) return;
    const owner = actionOwner.current;
    setBusy(current.id);
    setError(false);
    try {
      if (approve) await runtime.approveAutomaticPairing!(current.id);
      else await runtime.declineAutomaticPairing!(current.id);
      if (owner !== actionOwner.current) return;
      deferred.current.add(current.id);
      setSelected(null);
      if (!approve) setRequests((rows) => rows.filter((row) => row.id !== current.id));
    } catch {
      if (owner === actionOwner.current) setError(true);
    } finally {
      if (owner === actionOwner.current) setBusy(null);
    }
  };
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
        open={Boolean(current)}
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
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('e2ee.auto.newRequest')}</span>
              <Button variant="ghost" onClick={later}>
                {t('e2ee.auto.later')}
              </Button>
            </div>
            <Dialog.Title className="text-2xl leading-snug">
              {t('e2ee.auto.approve.title')}
            </Dialog.Title>
            <Dialog.Description>{t('e2ee.auto.approve.help')}</Dialog.Description>
            {current && (
              <>
                <p className="mt-2 text-sm font-medium">{current.deviceName}</p>
                <ComparisonCode code={current.comparisonCode} />
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
                    disabled={
                      Boolean(busy) || !current.comparisonCode || current.expiresAt <= Date.now()
                    }
                    onClick={() => void act(true)}
                  >
                    {t(busy ? 'e2ee.auto.confirming' : 'e2ee.auto.authorize')}
                  </Button>
                </div>
                {error && (
                  <p role="alert" className="text-sm text-muted-foreground">
                    {t('e2ee.auto.approvalRetry')}
                  </p>
                )}
                <p className="text-center text-xs text-muted-foreground">
                  {t('e2ee.auto.laterHint')}
                </p>
              </>
            )}
          </PrivatePairingSurface>
        </Dialog.Content>
      </Dialog.Root>
    </RequestsContext.Provider>
  );
}
