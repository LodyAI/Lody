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
  | 'personalPairingOffer'
  | 'preparePersonalJoin'
  | 'inspectPersonalJoin'
  | 'approvePersonalJoin'
  | 'claimPersonalJoin'
  | 'cancelPersonalJoin'
>;
type Preview = Awaited<ReturnType<NonNullable<Runtime['inspectPersonalJoin']>>>;

/** Host-verified evidence is displayed before a separate approval click. An
 * invitation is imported only after the person transfers the existing host's pin. */
export function E2eePersonalPairing({
  workspaceId,
  runtime,
  canApprove,
  onJoined,
}: {
  workspaceId: string;
  runtime: Runtime;
  canApprove: boolean;
  onJoined: () => void;
}) {
  const { t } = useTranslation();
  const [offer, setOffer] = useState<E2eePersonalPairingOffer | null>(null);
  const [input, setInput] = useState('');
  const [joining, setJoining] = useState<{
    pairingSessionId: string;
    signingPublicKey: string;
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
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const work = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPhase('busy');
    try {
      await operation();
    } catch {
      if (live.current) setPhase('error');
    } finally {
      busy.current = false;
    }
  };
  if (
    !runtime.preparePersonalJoin ||
    !runtime.personalPairingOffer ||
    !runtime.inspectPersonalJoin ||
    !runtime.approvePersonalJoin ||
    !runtime.claimPersonalJoin ||
    !runtime.cancelPersonalJoin
  )
    return null;
  const createOffer = () =>
    work(async () => {
      const value = await runtime.personalPairingOffer!(workspaceId);
      if (live.current) {
        setOffer(value);
        setPhase('idle');
      }
    });
  const prepare = () =>
    work(async () => {
      const value: E2eePersonalPairingOffer = JSON.parse(input);
      if (value.workspaceId !== workspaceId) throw new Error('wrong_workspace');
      const result = await runtime.preparePersonalJoin!(value);
      if (live.current) {
        if (result.status === 'cancelled' || result.status === 'conflict') {
          setJoining(null);
          setInput('');
          setPhase(result.status === 'cancelled' ? 'cancelled' : 'conflict');
        } else {
          setJoining(result);
          setPhase('waiting');
        }
      }
    });
  const inspect = () =>
    work(async () => {
      try {
        const result = await runtime.inspectPersonalJoin!(workspaceId, offer!.pairingSessionId);
        if (live.current) {
          setPreview(result);
          setPhase('idle');
        }
      } catch (error) {
        if (error instanceof Error && /e2ee_join_(cancelled|conflict)/.test(error.message)) {
          if (live.current) {
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
      if (live.current) setPhase(result.invitationPublished ? 'published' : 'retryPublication');
    });
  const claim = () =>
    work(async () => {
      const result = await runtime.claimPersonalJoin!(workspaceId, joining!.pairingSessionId);
      if (live.current) {
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
  const cancel = () =>
    work(async () => {
      await runtime.cancelPersonalJoin!(workspaceId, joining!.pairingSessionId);
      if (live.current) {
        setPhase('cancelled');
        setJoining(null);
        setInput('');
      }
    });
  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>{t('e2ee.pair.title')}</Card.Title>
        <Card.Description>{t('e2ee.pair.help')}</Card.Description>
      </Card.Header>
      <div {...stylex.props(styles.actions)}>
        {canApprove && !offer && (
          <Button
            variant="secondary"
            disabled={phase === 'busy'}
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
          <Button variant="secondary" disabled={phase === 'busy'} onClick={() => void inspect()}>
            {t('e2ee.pair.inspect')}
          </Button>
        </>
      )}
      {!canApprove && !joining && (
        <>
          <Textarea
            aria-label={t('e2ee.pair.code')}
            value={input}
            maxLength={20000}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={!input || phase === 'busy'}
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
          <p {...stylex.props(styles.code)}>{joining.signingPublicKey}</p>
          <div {...stylex.props(styles.actions)}>
            <Button
              disabled={phase === 'busy' || phase === 'cancelled'}
              onClick={() => void claim()}
            >
              {t('e2ee.pair.claim')}
            </Button>
            <Button
              variant="ghost"
              disabled={phase === 'busy' || phase === 'cancelled' || phase === 'ready'}
              onClick={() => void cancel()}
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
