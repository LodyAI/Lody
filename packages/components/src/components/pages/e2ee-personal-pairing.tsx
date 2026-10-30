import { E2eeIdentityRecovery } from './e2ee-identity-recovery';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import type { E2eePersonalPairingOffer } from '@lody/cloud-api';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { LedgerQrCode } from './e2ee-ledger-verification';

const styles = stylex.create({
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  code: { overflowWrap: 'anywhere', userSelect: 'all', fontFamily: 'monospace', margin: 0 },
  qr: { backgroundColor: '#ffffff', padding: space[2], alignSelf: 'flex-start' },
  error: { color: colors.secondaryLabel },
});
type Runtime = Pick<
  E2eeWorkspaceRuntime,
  | 'resetIdentity'
  | 'personalPairingOffer'
  | 'preparePersonalJoin'
  | 'pendingPersonalJoin'
  | 'inspectPersonalJoin'
  | 'approvePersonalJoin'
  | 'claimPersonalJoin'
  | 'cancelPersonalJoin'
>;
type Preview = Awaited<ReturnType<NonNullable<Runtime['inspectPersonalJoin']>>>;

/** Host-verified evidence is displayed before a separate approval click. An
 * invitation is imported only after the person transfers the existing host's pin. */
export function E2eePersonalPairing(props: {
  workspaceId: string;
  runtime: Runtime;
  canApprove: boolean;
  /** Display only: a successful host read-open already admitted this device. */
  approved?: boolean;
  onJoined: () => void;
}) {
  // A workspace owns its pending originals and async UI results. Never carry
  // the previous workspace's session into a route switch.
  return <PersonalPairingSession key={props.workspaceId} {...props} />;
}

function PersonalPairingSession({
  workspaceId,
  runtime,
  canApprove,
  approved,
  onJoined,
}: {
  workspaceId: string;
  runtime: Runtime;
  canApprove: boolean;
  approved?: boolean;
  onJoined: () => void;
}) {
  const { t } = useTranslation();
  const [recoveryError, setRecoveryError] = useState('');
  const [offer, setOffer] = useState<E2eePersonalPairingOffer | null>(null);
  const [input, setInput] = useState('');
  const [joining, setJoining] = useState<{
    pairingSessionId: string;
    signingPublicKey?: string;
    offer: E2eePersonalPairingOffer;
  } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<
    | 'idle'
    | 'busy'
    | 'waiting'
    | 'published'
    | 'retryPublication'
    | 'cancelled'
    | 'conflict'
    | 'ready'
    | 'error'
  >('idle');
  const live = useRef(true);
  const busy = useRef(false);
  const currentRuntime = useRef(runtime);
  currentRuntime.current = runtime;
  const isLive = () => live.current && currentRuntime.current === runtime;
  const [recovering, setRecovering] = useState(Boolean(runtime.pendingPersonalJoin));
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setRecovering(Boolean(runtime.pendingPersonalJoin));
    if (runtime.pendingPersonalJoin) {
      void runtime.pendingPersonalJoin(workspaceId).then(
        (pending) => {
          if (cancelled) return;
          setJoining(pending);
          if (pending) setPhase('waiting');
          setRecovering(false);
        },
        (error) => {
          if (cancelled) return;
          setRecoveryError(error instanceof Error ? error.message : '');
          setPhase('error');
          setRecovering(false);
        }
      );
    }
    return () => {
      cancelled = true;
    };
  }, [runtime, workspaceId]);
  const work = async (operation: () => Promise<void>) => {
    if (busy.current || recovering) return;
    busy.current = true;
    setPhase('busy');
    try {
      await operation();
    } catch (error) {
      if (isLive()) {
        setRecoveryError(error instanceof Error ? error.message : '');
        setPhase('error');
      }
    } finally {
      busy.current = false;
    }
  };
  const canRequest = Boolean(
    runtime.preparePersonalJoin && runtime.claimPersonalJoin && runtime.cancelPersonalJoin
  );
  const canEndorse = Boolean(
    canApprove &&
    runtime.personalPairingOffer &&
    runtime.inspectPersonalJoin &&
    runtime.approvePersonalJoin &&
    runtime.cancelPersonalJoin
  );
  if ((!canRequest && !canEndorse) || (approved && !canEndorse)) return null;
  const createOffer = () =>
    work(async () => {
      const value = await runtime.personalPairingOffer!(workspaceId);
      if (isLive()) {
        setOffer(value);
        setPhase('idle');
      }
    });
  const prepare = (retainedOffer?: E2eePersonalPairingOffer) =>
    work(async () => {
      const value: E2eePersonalPairingOffer = retainedOffer ?? JSON.parse(input);
      if (value.workspaceId !== workspaceId) throw new Error('wrong_workspace');
      let result;
      try {
        result = await runtime.preparePersonalJoin!(value);
      } catch (error) {
        // begin may fail after the host saved its immutable request. Recover
        // the actual session so cancellation/reconciliation remains reachable.
        try {
          const pending = await runtime.pendingPersonalJoin?.(workspaceId);
          if (isLive() && pending) setJoining(pending);
        } catch {
          // Keep the original prepare failure; another normal query can retry.
        }
        throw error;
      }
      if (isLive()) {
        if (result.status === 'cancelled' || result.status === 'conflict') {
          setJoining(null);
          setInput('');
          setPhase(result.status === 'cancelled' ? 'cancelled' : 'conflict');
        } else {
          setJoining({ ...result, offer: value });
          setPhase('waiting');
        }
      }
    });
  const inspect = () =>
    work(async () => {
      try {
        const result = await runtime.inspectPersonalJoin!(workspaceId, offer!.pairingSessionId);
        if (isLive()) {
          setPreview(result);
          setPhase('idle');
        }
      } catch (error) {
        if (error instanceof Error && /e2ee_join_(cancelled|conflict)/.test(error.message)) {
          if (isLive()) {
            setOffer(null);
            setPreview(null);
            setPhase(error.message.includes('cancelled') ? 'cancelled' : 'conflict');
          }
        } else throw error;
      }
    });
  const approve = () =>
    work(async () => {
      const result = await runtime.approvePersonalJoin!(workspaceId, preview!.pairingSessionId);
      if (isLive()) setPhase(result.invitationPublished ? 'published' : 'retryPublication');
    });
  const claim = () =>
    work(async () => {
      const result = await runtime.claimPersonalJoin!(workspaceId, joining!.pairingSessionId);
      if (isLive()) {
        if (result.status === 'cancelled' || result.status === 'conflict') {
          setJoining(null);
          setInput('');
          setPhase(result.status === 'cancelled' ? 'cancelled' : 'conflict');
          return;
        }
        setPhase(result.ready ? 'ready' : 'waiting');
        if (result.ready) onJoined();
      }
    });
  const cancel = (pairingSessionId: string) =>
    work(async () => {
      await runtime.cancelPersonalJoin!(workspaceId, pairingSessionId);
      if (isLive()) {
        setPhase('cancelled');
        setJoining(null);
        setOffer(null);
        setPreview(null);
        setInput('');
      }
    });
  return (
    <Card.Root>
      {phase === 'error' && (
        <E2eeIdentityRecovery
          error={recoveryError}
          runtime={runtime}
          workspaceId={workspaceId}
          onReset={() => {
            setRecoveryError('');
            setJoining(null);
            setPhase('idle');
            onJoined();
          }}
        />
      )}
      <Card.Header>
        <Card.Title>
          {t(canEndorse ? 'e2ee.pair.title' : 'e2ee.pair.desktopApprovalRequired')}
        </Card.Title>
        <Card.Description>{t('e2ee.pair.help')}</Card.Description>
      </Card.Header>
      <div {...stylex.props(styles.actions)}>
        {canEndorse && !offer && (
          <Button
            variant="secondary"
            disabled={phase === 'busy' || recovering}
            onClick={() => void createOffer()}
          >
            {t('e2ee.pair.create')}
          </Button>
        )}
      </div>
      {offer && (
        <>
          <p>{t('e2ee.pair.transfer')}</p>
          <div {...stylex.props(styles.qr)}>
            <LedgerQrCode payload={JSON.stringify(offer)} size={200} label={t('e2ee.pair.code')} />
          </div>
          <Textarea aria-label={t('e2ee.pair.code')} value={JSON.stringify(offer)} readOnly />
          <Button
            variant="secondary"
            disabled={phase === 'busy' || recovering}
            onClick={() => void inspect()}
          >
            {t('e2ee.pair.inspect')}
          </Button>
          <Button
            variant="ghost"
            disabled={phase === 'busy' || recovering || phase === 'published'}
            onClick={() => void cancel(offer.pairingSessionId)}
          >
            {t('common.cancel')}
          </Button>
        </>
      )}
      {canRequest && !canEndorse && !joining && (
        <>
          <Textarea
            aria-label={t('e2ee.pair.code')}
            value={input}
            maxLength={20000}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!input || phase === 'busy' || recovering}
            onClick={() => void prepare()}
          >
            {t('e2ee.pair.trust')}
          </Button>
        </>
      )}
      {preview && (
        <>
          <p>{t('e2ee.pair.compare')}</p>
          <p {...stylex.props(styles.code)}>{preview.signingPublicKey}</p>
          <Button
            disabled={phase === 'busy' || phase === 'published'}
            onClick={() => void approve()}
          >
            {t(phase === 'retryPublication' ? 'e2ee.pair.retryPublication' : 'e2ee.pair.approve')}
          </Button>
        </>
      )}
      {joining && (
        <>
          {joining.signingPublicKey && (
            <p {...stylex.props(styles.code)}>{joining.signingPublicKey}</p>
          )}
          <div {...stylex.props(styles.actions)}>
            <Button
              disabled={phase === 'busy' || phase === 'cancelled'}
              onClick={() => void claim()}
            >
              {t('e2ee.pair.claim')}
            </Button>
            <Button
              variant="secondary"
              disabled={phase === 'busy' || phase === 'ready'}
              onClick={() => void prepare(joining.offer)}
            >
              {t('e2ee.pair.retrySubmission')}
            </Button>
            <Button
              variant="ghost"
              disabled={phase === 'busy' || phase === 'cancelled' || phase === 'ready'}
              onClick={() => void cancel(joining.pairingSessionId)}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </>
      )}
      {phase !== 'idle' && phase !== 'busy' && (
        <p role={phase === 'error' ? 'alert' : 'status'} {...stylex.props(styles.error)}>
          {t(`e2ee.pair.${phase}`)}
        </p>
      )}
    </Card.Root>
  );
}
