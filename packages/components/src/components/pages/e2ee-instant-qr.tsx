import * as stylex from '@stylexjs/stylex';
import { ChevronDown, CircleCheck, QrCode, RefreshCw } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  accountPairingErrorCode,
  type E2eeAccountPairingApproval,
  type E2eeWorkspaceRuntime,
} from '@lody/platform';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Collapsible } from '@lody/ui/collapsible';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';
import { holdPrivateTelemetrySurface } from '@/lib/posthog-privacy';
import { E2eeAccountPairingApprove, failureKey, qrPayload } from './e2ee-account-pairing';
import { LedgerQrCode } from './e2ee-ledger-verification';
import { useE2eeDeviceRequests } from './e2ee-device-requests';

/** Pauses session recording while a pairing secret or approval is on screen. */
export function usePairingPrivacy() {
  useLayoutEffect(() => {
    const release = holdPrivateTelemetrySurface();
    // Layout cleanup precedes host removal. Restart recording only after the
    // commit has removed the private DOM, including a portal's exit transition.
    return () => {
      queueMicrotask(release);
    };
  }, []);
}
export function PrivatePairingSurface({ children }: { children: ReactNode }) {
  usePairingPrivacy();
  return <>{children}</>;
}

export type InstantQrRuntime = Pick<
  E2eeWorkspaceRuntime,
  'accountPairingCode' | 'inspectAccountPairing' | 'approveAccountPairing'
>;
export const supportsInstantQr = (runtime: InstantQrRuntime | undefined) =>
  Boolean(
    runtime?.accountPairingCode && runtime.inspectAccountPairing && runtime.approveAccountPairing
  );

export type InstantQrPhase =
  | { kind: 'loading' }
  | { kind: 'showing'; pairingString: string; expiresAt: number }
  | { kind: 'joining'; deviceName: string; unavailable: string[] }
  | {
      kind: 'joined';
      deviceName: string;
      result: E2eeAccountPairingApproval;
      /** Requested workspaces this device cannot sign for; they stay pending. */
      unavailable: string[];
    }
  | { kind: 'expired' }
  | { kind: 'failed'; error: string };

const INSTANT_QR_POLL_MS = 900;

/**
 * One fresh approver-shows offer. The person showing this code on their own device is
 * the approval: once a request under it verifies, every listed workspace is signed
 * once, without a further confirmation. The secret never leaves this device's screen.
 */
export function useInstantQrOffer(
  runtime: InstantQrRuntime,
  options: { active: boolean; pollMs?: number }
) {
  const [phase, setPhase] = useState<InstantQrPhase>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const pollMs = options.pollMs ?? INSTANT_QR_POLL_MS;
  const enabled = options.active && supportsInstantQr(runtime);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let running = false;
    // At most one approval per offer: a slow host reply never signs twice.
    let approving = false;
    let offer: { pairingString: string; expiresAt: number } | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const poll = async () => {
      if (!alive || running || approving || !offer) return;
      // A hidden window does not sign; it resumes as soon as it is shown again.
      if (document.visibilityState !== 'visible') return;
      if (Date.now() >= offer.expiresAt) {
        stop();
        setPhase({ kind: 'expired' });
        return;
      }
      running = true;
      try {
        const preview = await runtime.inspectAccountPairing!(offer.pairingString);
        if (!alive || !preview || approving) return;
        if (preview.workspaces.length === 0) {
          stop();
          setPhase({ kind: 'failed', error: 'e2ee.instantQr.nothingToShare' });
          return;
        }
        approving = true;
        stop();
        const unavailable = preview.unavailable.map((workspace) => workspace.name);
        setPhase({ kind: 'joining', deviceName: preview.deviceName, unavailable });
        const result = await runtime.approveAccountPairing!({
          pairingString: offer.pairingString,
          requestId: preview.requestId,
          workspaceIds: preview.workspaces.map((workspace) => workspace.workspaceId),
        });
        if (!alive) return;
        setPhase(
          result.workspaces.some((workspace) => workspace.outcome !== 'not-admitted')
            ? { kind: 'joined', deviceName: preview.deviceName, result, unavailable }
            : { kind: 'failed', error: 'e2ee.accountPair.error.failed' }
        );
      } catch (failure) {
        if (!alive) return;
        // Before signing, a transient read failure keeps polling the same offer.
        if (!approving && !accountPairingErrorCode(failure)) return;
        stop();
        setPhase({ kind: 'failed', error: failureKey(failure) });
      } finally {
        running = false;
      }
    };
    const wake = () => void poll();
    document.addEventListener('visibilitychange', wake);
    setPhase({ kind: 'loading' });
    void (async () => {
      try {
        const next = await runtime.accountPairingCode!();
        if (!alive) return;
        offer = next;
        setPhase({ kind: 'showing', ...next });
        timer = setInterval(() => void poll(), pollMs);
      } catch (failure) {
        if (alive) setPhase({ kind: 'failed', error: failureKey(failure) });
      }
    })();
    return () => {
      alive = false;
      stop();
      document.removeEventListener('visibilitychange', wake);
    };
  }, [runtime, enabled, generation, pollMs]);
  return { phase, refresh: () => setGeneration((value) => value + 1) };
}

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[3],
    textAlign: 'center',
  },
  qr: {
    backgroundColor: '#ffffff',
    padding: space[2],
    borderRadius: radius.medium,
    lineHeight: 0,
  },
  qrFaded: { opacity: 0.15, width: 212, height: 212 },
  frame: { position: 'relative', display: 'grid', placeItems: 'center' },
  overlay: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' },
  lead: { margin: 0, fontWeight: 600 },
  quiet: { margin: 0, color: colors.secondaryLabel, fontSize: type.footnoteSize },
  status: {
    margin: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: type.subheadlineSize,
  },
  success: { color: colors.success },
  card: { display: 'flex', flexDirection: 'column', gap: space[3] },
  cardLead: { margin: 0, color: colors.secondaryLabel },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  disclosure: { display: 'flex', flexDirection: 'column', gap: space[2] },
  callout: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    padding: space[3],
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
  },
});

/** Shows a one-time pairing QR code; a phone that scans it joins with no further step. */
export function E2eeInstantQrApprove(props: {
  runtime: InstantQrRuntime;
  /** Called once a device joined through this code. */
  onJoined?: (deviceName: string) => void;
  pollMs?: number;
}) {
  const { t } = useTranslation();
  const { phase, refresh } = useInstantQrOffer(props.runtime, {
    active: true,
    ...(props.pollMs === undefined ? {} : { pollMs: props.pollMs }),
  });
  const requests = useE2eeDeviceRequests();
  const joinedRef = useRef(() => {});
  joinedRef.current = () => {
    if (phase.kind !== 'joined') return;
    // The joined device's automatic request needs no popup of its own afterwards.
    requests?.joinedByCode();
    props.onJoined?.(phase.deviceName);
  };
  const joinedDevice = phase.kind === 'joined' ? phase.deviceName : null;
  useEffect(() => {
    if (joinedDevice !== null) joinedRef.current();
  }, [joinedDevice]);
  const unavailable =
    phase.kind === 'joining' || phase.kind === 'joined' ? phase.unavailable : [];
  if (!supportsInstantQr(props.runtime)) return null;
  const pairingString = phase.kind === 'showing' ? phase.pairingString : null;
  return (
    <PrivatePairingSurface>
      <div data-testid="e2ee-instant-qr" data-phase={phase.kind} {...stylex.props(styles.root)}>
        <p {...stylex.props(styles.lead)}>{t('e2ee.instantQr.lead')}</p>
        <div {...stylex.props(styles.frame)}>
          {pairingString ? (
            <div {...stylex.props(styles.qr)}>
              <LedgerQrCode
                payload={qrPayload(pairingString)}
                size={196}
                label={t('e2ee.accountPair.code.label')}
              />
            </div>
          ) : (
            <div
              aria-hidden="true"
              {...stylex.props(styles.qr, styles.qrFaded)}
            />
          )}
          {phase.kind === 'loading' && (
            <span {...stylex.props(styles.overlay)}>
              <Spinner size="small" />
            </span>
          )}
        </div>
        <div aria-live="polite">
          {phase.kind === 'showing' && (
            <p {...stylex.props(styles.quiet)}>{t('e2ee.instantQr.help')}</p>
          )}
          {phase.kind === 'joining' && (
            <p role="status" {...stylex.props(styles.status)}>
              <Spinner size="small" />
              {t('e2ee.instantQr.joining', { device: phase.deviceName })}
            </p>
          )}
          {phase.kind === 'joined' && (
            <p role="status" {...stylex.props(styles.status, styles.success)}>
              <CircleCheck size={16} aria-hidden="true" />
              {t('e2ee.instantQr.joined', { device: phase.deviceName })}
            </p>
          )}
          {unavailable.length > 0 && (
            <p {...stylex.props(styles.quiet)}>
              {t('e2ee.instantQr.unavailable', {
                count: unavailable.length,
                names: unavailable.join(', '),
              })}
            </p>
          )}
          {phase.kind === 'expired' && (
            <p role="status" {...stylex.props(styles.quiet)}>
              {t('e2ee.instantQr.expired')}
            </p>
          )}
          {phase.kind === 'failed' && (
            <p role="alert" {...stylex.props(styles.quiet)}>
              {t(phase.error)}
            </p>
          )}
        </div>
        {(phase.kind === 'expired' || phase.kind === 'failed' || phase.kind === 'joined') && (
          <Button variant="secondary" size="small" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" />
            {t(phase.kind === 'joined' ? 'e2ee.instantQr.another' : 'e2ee.instantQr.refresh')}
          </Button>
        )}
      </div>
    </PrivatePairingSurface>
  );
}

type AddDeviceRuntime = InstantQrRuntime &
  Pick<E2eeWorkspaceRuntime, 'declineAccountPairing'>;

/** The console's one way to add a personal device: a QR code a phone scans to join,
 * with manual code entry for a device that has no camera. */
export function E2eeAddDeviceCard(props: {
  runtime: AddDeviceRuntime;
  /** Opened through an explicit "Add device": show the code at once. */
  defaultShowQr?: boolean;
}) {
  const { t } = useTranslation();
  const [showing, setShowing] = useState(props.defaultShowQr === true);
  const requests = useE2eeDeviceRequests();
  const [manual, setManual] = useState(false);
  if (!supportsInstantQr(props.runtime)) return <E2eeAccountPairingApprove runtime={props.runtime} />;
  return (
    <>
      <Card.Root data-testid="e2ee-add-device">
        <div {...stylex.props(styles.card)}>
          <Card.Title>{t('e2ee.addDevice.title')}</Card.Title>
          <p {...stylex.props(styles.cardLead)}>{t('e2ee.addDevice.lead')}</p>
          {requests && requests.count > 0 && <E2eeWaitingRequestsCallout />}
          {showing ? (
            <>
              <E2eeInstantQrApprove runtime={props.runtime} />
              <div {...stylex.props(styles.actions)}>
                <Button variant="ghost" size="small" onClick={() => setShowing(false)}>
                  {t('e2ee.addDevice.hideQr')}
                </Button>
              </div>
            </>
          ) : (
            <div {...stylex.props(styles.actions)}>
              <Button data-testid="e2ee-add-device-show-qr" onClick={() => setShowing(true)}>
                <QrCode size={16} aria-hidden="true" />
                {t('e2ee.addDevice.showQr')}
              </Button>
            </div>
          )}
        </div>
      </Card.Root>
      <Collapsible.Root open={manual} onOpenChange={setManual}>
        <div {...stylex.props(styles.disclosure)}>
          <Collapsible.Trigger
            render={<Button variant="ghost" size="small" data-testid="e2ee-add-device-manual" />}
          >
            {t('e2ee.addDevice.manual')}
            <ChevronDown size={14} aria-hidden="true" />
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <E2eeAccountPairingApprove runtime={props.runtime} />
          </Collapsible.Panel>
        </div>
      </Collapsible.Root>
    </>
  );
}

const AUTO_PAIR_PREFIX = 'lody://auto-pair?';
/** The new device's comparison code as a QR payload. It carries only what that screen
 * already shows: scanning it is the same as typing the code, and the approving device
 * still compares it with its own before signing. */
export const autoPairQrPayload = (id: string, code: string) =>
  `${AUTO_PAIR_PREFIX}${new URLSearchParams({ id, code }).toString()}`;
export function parseAutoPairQr(text: string): { id: string; code: string } | null {
  const value = text.trim();
  if (!value.toLowerCase().startsWith(AUTO_PAIR_PREFIX)) return null;
  const params = new URLSearchParams(value.slice(AUTO_PAIR_PREFIX.length));
  const id = params.get('id'),
    code = params.get('code');
  return id && code && /^\d{6}$/.test(code) ? { id, code } : null;
}

/** Requests already waiting, reachable from inside Settings or the console: a new
 * computer is approved with its code there, not by scanning. */
export function E2eeWaitingRequestsCallout() {
  const { t } = useTranslation();
  const requests = useE2eeDeviceRequests();
  if (!requests || requests.count === 0) return null;
  return (
    <div data-testid="e2ee-waiting-requests" {...stylex.props(styles.callout)}>
      <span>{t('e2ee.addDevice.waiting', { count: requests.count })}</span>
      <Button size="small" variant="secondary" onClick={requests.review}>
        {t('e2ee.auto.review')}
      </Button>
    </div>
  );
}
