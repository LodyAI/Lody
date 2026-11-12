import { E2eeIdentityRecovery } from './pages/e2ee-identity-recovery';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { Button } from '@lody/ui/button';
// The product adapter mounts the window drag strip on the overlay, so the desktop
// window stays movable while the confirmation is open.
import { AlertDialog } from '@/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';

type Pairing = Awaited<ReturnType<NonNullable<E2eeWorkspaceRuntime['prepareLocalAgent']>>>;
type Runtime = Pick<
  E2eeWorkspaceRuntime,
  'prepareLocalAgent' | 'admitLocalAgent' | 'status' | 'resetLocalAgent' | 'resetIdentity'
>;

/** The longest this view shows one preparation or admission as in progress. Main keeps
 * working past it; the view moves to waiting, and an exact retry rejoins that work. */
export const LOCAL_AGENT_STEP_DEADLINE_MS = 45_000;
/** While waiting, check again after these delays; then wait for the user to retry. */
export const LOCAL_AGENT_RECHECK_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000, 30_000];
const PENDING = 'e2ee_local_agent_pending';
const withinDeadline = <T,>(work: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(PENDING)),
      LOCAL_AGENT_STEP_DEADLINE_MS
    );
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
const styles = stylex.create({
  notice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    marginBottom: space[3],
    color: colors.secondaryLabel,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  message: { margin: 0 },
});

/** Each new local pairing session requires consent, including an already admitted machine. */
export function E2eeLocalAgentApproval(props: {
  workspaceId: string;
  runtime: Runtime | undefined;
  enabled: boolean;
}) {
  // No pairing, approval or phase crosses to another workspace.
  return <LocalAgentApproval key={props.workspaceId} {...props} />;
}

function LocalAgentApproval({
  workspaceId,
  runtime,
  enabled,
}: {
  workspaceId: string;
  runtime: Runtime | undefined;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<
    'idle' | 'preparing' | 'confirm' | 'admitting' | 'waiting' | 'error' | 'ready'
  >('idle');
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryMachine, setRecoveryMachine] = useState(true);
  const [admitted, setAdmitted] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const approved = useRef(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    setAvailable(null);
    if (enabled && runtime)
      void runtime.status(workspaceId).then(
        (status) => {
          if (current) setAvailable(status.hasDeviceCredential === true);
        },
        (error) => {
          if (current) {
            setRecoveryMachine(false);
            setRecoveryError(error instanceof Error ? error.message : '');
            setPhase('error');
          }
        }
      );
    return () => {
      current = false;
    };
  }, [enabled, runtime, workspaceId]);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // Each attempt owns the phase only until a newer one starts; a result that arrives
  // after its deadline or after a newer attempt changes nothing.
  const attempt = useRef(0);
  const current = (owner: number) => active.current && attempt.current === owner;
  const [recheck, setRecheck] = useState(0);
  const prepareRef = useRef<(automatic: boolean) => Promise<void>>(async () => {});
  // While waiting, reconcile on a bounded backoff so a slow start completes without a
  // click. A hidden window waits until it is visible again; any other phase cancels.
  useEffect(() => {
    if (phase !== 'waiting' || recheck >= LOCAL_AGENT_RECHECK_DELAYS_MS.length) return undefined;
    let visibilityWait: (() => void) | undefined;
    const run = () => void prepareRef.current(true);
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== 'hidden') return run();
      const visible = () => {
        if (document.visibilityState === 'hidden') return;
        document.removeEventListener('visibilitychange', visible);
        visibilityWait = undefined;
        run();
      };
      document.addEventListener('visibilitychange', visible);
      visibilityWait = () => document.removeEventListener('visibilitychange', visible);
    }, LOCAL_AGENT_RECHECK_DELAYS_MS[recheck]);
    return () => {
      window.clearTimeout(timer);
      visibilityWait?.();
    };
  }, [phase, recheck]);
  if (
    !enabled ||
    available === false ||
    (available === null && phase !== 'error') ||
    !runtime?.prepareLocalAgent ||
    !runtime.admitLocalAgent ||
    phase === 'ready'
  )
    return null;
  const prepareLocalAgent = runtime.prepareLocalAgent;
  const admitLocalAgent = runtime.admitLocalAgent;
  const busy = phase === 'preparing' || phase === 'admitting';
  const fail = (owner: number, error: unknown) => {
    if (!current(owner)) return;
    if (error instanceof Error) {
      setRecoveryError(error.message);
      setRecoveryMachine(/\be2ee_machine_/.test(error.message));
    }
    setPhase(error instanceof Error && error.message.includes(PENDING) ? 'waiting' : 'error');
  };
  const admit = async (material: Pairing, owner = ++attempt.current) => {
    approved.current = true;
    setPhase('admitting');
    try {
      const result = await withinDeadline(
        admitLocalAgent(workspaceId, material.pairingSessionId)
      );
      if (!current(owner)) return;
      setAdmitted(true);
      setPhase(result.ready ? 'ready' : 'waiting');
    } catch (error) {
      fail(owner, error);
    }
  };
  const prepare = async (automatic = false) => {
    if (busy) return;
    // A click starts a fresh round of automatic checks; an automatic check uses one.
    setRecheck((count) => (automatic ? count + 1 : 0));
    const owner = ++attempt.current;
    setPhase('preparing');
    try {
      const status = await withinDeadline(runtime.status(workspaceId));
      if (!current(owner)) return;
      setAvailable(status.hasDeviceCredential === true);
      if (!status.hasDeviceCredential) {
        setPhase('idle');
        return;
      }
      const material = await withinDeadline(prepareLocalAgent(workspaceId));
      if (!current(owner)) return;
      setPairing(material);
      setAdmitted(material.admitted);
      // Only the session the user already approved continues without asking again.
      if (approved.current && pairing?.pairingSessionId === material.pairingSessionId)
        await admit(material, owner);
      else {
        approved.current = false;
        setPhase('confirm');
      }
    } catch (error) {
      fail(owner, error);
    }
  };
  prepareRef.current = prepare;
  return (
    <>
      <section {...stylex.props(styles.notice)} aria-label={t('e2ee.localAgent.title')}>
        <p {...stylex.props(styles.message)} role={phase === 'error' ? 'alert' : 'status'}>
          {t(
            phase === 'waiting'
              ? admitted
                ? 'e2ee.localAgent.waiting'
                : 'e2ee.localAgent.preparationPending'
              : phase === 'error'
                ? admitted
                  ? 'e2ee.localAgent.admittedRetry'
                  : approved.current
                    ? 'e2ee.localAgent.approvedRetry'
                    : 'e2ee.localAgent.retryHelp'
                : 'e2ee.localAgent.description'
          )}
        </p>
        <Button
          size="small"
          variant="secondary"
          disabled={busy}
          onClick={() => void prepare(false)}
        >
          {t(
            busy
              ? 'e2ee.localAgent.working'
              : phase === 'waiting' || phase === 'error'
                ? 'common.tryAgain'
                : 'e2ee.localAgent.enable'
          )}
        </Button>
      </section>
      {phase === 'error' && (
        <E2eeIdentityRecovery
          error={recoveryError}
          runtime={runtime}
          workspaceId={workspaceId}
          machine={recoveryMachine}
          onReset={() => {
            approved.current = false;
            setPairing(null);
            setRecoveryError('');
            setPhase('idle');
          }}
        />
      )}
      <AlertDialog.Root
        open={phase === 'confirm'}
        onOpenChange={(open) => {
          if (!open && phase === 'confirm' && !approved.current) {
            setPairing(null);
            setPhase('idle');
          }
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('e2ee.localAgent.confirm')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('e2ee.localAgent.confirmHelp')}
              {pairing?.protection === 'file' ? ` ${t('e2ee.localAgent.fileProtection')}` : ''}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Close render={<Button variant="secondary" />}>
              {t('common.cancel')}
            </AlertDialog.Close>
            <Button
              variant="primary"
              onClick={() => {
                if (pairing) void admit(pairing);
              }}
            >
              {t('e2ee.localAgent.allow')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
