import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@lody/ui/alert-dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';

type Pairing = Awaited<ReturnType<NonNullable<E2eeWorkspaceRuntime['prepareLocalAgent']>>>;
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

/** Approval stays explicit; an admitted machine can retry key delivery without reapproval. */
export function E2eeLocalAgentApproval({
  workspaceId,
  runtime,
  enabled,
}: {
  workspaceId: string;
  runtime:
    | Pick<E2eeWorkspaceRuntime, 'prepareLocalAgent' | 'admitLocalAgent' | 'status'>
    | undefined;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<
    'idle' | 'preparing' | 'confirm' | 'admitting' | 'waiting' | 'error' | 'ready'
  >('idle');
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
        () => {
          if (current) setPhase('error');
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
  const admit = async (material: Pairing) => {
    approved.current = true;
    setPhase('admitting');
    try {
      const result = await admitLocalAgent(workspaceId, material.pairingSessionId);
      if (active.current) {
        setAdmitted(true);
        setPhase(result.ready ? 'ready' : 'waiting');
      }
    } catch (error) {
      if (active.current)
        setPhase(
          error instanceof Error && error.message.includes('e2ee_local_agent_pending')
            ? 'waiting'
            : 'error'
        );
    }
  };
  const prepare = async () => {
    if (busy) return;
    setPhase('preparing');
    try {
      const status = await runtime.status(workspaceId);
      if (!active.current) return;
      setAvailable(status.hasDeviceCredential === true);
      if (!status.hasDeviceCredential) return;
      const material = await prepareLocalAgent(workspaceId);
      if (!active.current) return;
      setPairing(material);
      setAdmitted(material.admitted);
      if (
        material.admitted ||
        (approved.current && pairing?.pairingSessionId === material.pairingSessionId)
      )
        await admit(material);
      else {
        approved.current = false;
        setPhase('confirm');
      }
    } catch (error) {
      if (active.current)
        setPhase(
          error instanceof Error && error.message.includes('e2ee_local_agent_pending')
            ? 'waiting'
            : 'error'
        );
    }
  };
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
        <Button size="small" variant="secondary" disabled={busy} onClick={() => void prepare()}>
          {t(
            busy
              ? 'e2ee.localAgent.working'
              : phase === 'waiting' || phase === 'error'
                ? 'common.tryAgain'
                : 'e2ee.localAgent.enable'
          )}
        </Button>
      </section>
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
