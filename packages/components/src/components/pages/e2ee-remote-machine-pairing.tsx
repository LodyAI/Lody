import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
type Runtime = Pick<
  E2eeWorkspaceRuntime,
  | 'beginRemoteMachinePairing'
  | 'inspectRemoteMachinePairing'
  | 'approveRemoteMachinePairing'
  | 'cancelRemoteMachinePairing'
>;
type Preview = Awaited<ReturnType<NonNullable<Runtime['inspectRemoteMachinePairing']>>>;
const styles = stylex.create({
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  code: { fontFamily: 'monospace', overflowWrap: 'anywhere', userSelect: 'all' },
  message: { color: colors.secondaryLabel },
});
/** An expiring command transfers pins. A separate, material-bound click grants consent. */
export function E2eeRemoteMachinePairing({
  workspaceId,
  runtime,
}: {
  workspaceId: string;
  runtime: Runtime;
}) {
  const { t } = useTranslation();
  const [session, setSession] = useState<{ pairingSessionId: string; command: string } | null>(
    null
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  // A revoked identity cannot be readmitted; the machine must create a new one.
  const [error, setError] = useState<false | 'generic' | 'key-revoked'>(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  if (
    !runtime.beginRemoteMachinePairing ||
    !runtime.inspectRemoteMachinePairing ||
    !runtime.approveRemoteMachinePairing ||
    !runtime.cancelRemoteMachinePairing
  )
    return null;
  const begin = runtime.beginRemoteMachinePairing,
    inspect = runtime.inspectRemoteMachinePairing,
    approve = runtime.approveRemoteMachinePairing,
    cancel = runtime.cancelRemoteMachinePairing;
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await work();
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error && /\be2ee_pairing_key_revoked$/.test(cause.message)
            ? 'key-revoked'
            : 'generic'
        );
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const refresh = async () => {
    if (!session) return;
    const next = await inspect(workspaceId, session.pairingSessionId);
    if (active.current) setPreview(next);
  };
  const terminal =
    preview && ['cancelled', 'expired', 'conflict', 'ready'].includes(preview.status);
  const location =
    [preview?.location?.city, preview?.location?.country].filter(Boolean).join(', ') ||
    t('e2ee.remoteMachine.unknown');
  return (
    <Card.Root>
      <Card.Header>
        <Card.Title>{t('e2ee.remoteMachine.title')}</Card.Title>
        <Card.Description>{t('e2ee.remoteMachine.description')}</Card.Description>
      </Card.Header>
      <div>
        {error && (
          <p role="alert">
            {t(
              error === 'key-revoked' ? 'e2ee.remoteMachine.keyRevoked' : 'e2ee.remoteMachine.error'
            )}
          </p>
        )}
        {session && (
          <>
            <Textarea
              aria-label={t('e2ee.remoteMachine.command')}
              value={session.command}
              readOnly
            />
            <p {...stylex.props(styles.message)}>{t('e2ee.remoteMachine.commandHelp')}</p>
          </>
        )}
        {preview && <p role="status">{t(`e2ee.remoteMachine.status.${preview.status}`)}</p>}
        {preview?.summary && (
          <>
            <p>{t('e2ee.remoteMachine.machine', { id: preview.material?.machineId })}</p>
            <p {...stylex.props(styles.code)}>{preview.summary}</p>
            <p>{t('e2ee.remoteMachine.location', { location })}</p>
            <p {...stylex.props(styles.message)}>{t('e2ee.remoteMachine.locationHelp')}</p>
            <p>
              {t(
                preview.material?.protection === 'file'
                  ? 'e2ee.localAgent.fileProtection'
                  : 'e2ee.remoteMachine.osProtection'
              )}
            </p>
            <p>{t('e2ee.remoteMachine.compare')}</p>
          </>
        )}
        <div {...stylex.props(styles.actions)}>
          {!session && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await begin(workspaceId);
                  if (active.current) {
                    setSession(next);
                    setPreview(null);
                  }
                })
              }
            >
              {t('e2ee.remoteMachine.create')}
            </Button>
          )}
          {session && !terminal && (
            <Button variant="secondary" disabled={busy} onClick={() => void run(refresh)}>
              {t('e2ee.remoteMachine.check')}
            </Button>
          )}
          {session &&
            preview?.summary &&
            ['claimed', 'admitting', 'admitted'].includes(preview.status) && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await approve(workspaceId, session.pairingSessionId, preview.summary ?? '');
                    await refresh();
                  })
                }
              >
                {t(
                  preview.status === 'claimed'
                    ? 'e2ee.remoteMachine.allow'
                    : 'e2ee.remoteMachine.resume'
                )}
              </Button>
            )}
          {session && (!preview || !['admitting', 'admitted'].includes(preview.status)) && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await cancel(workspaceId, session.pairingSessionId);
                  if (active.current) {
                    setSession(null);
                    setPreview(null);
                  }
                })
              }
            >
              {t(terminal ? 'e2ee.remoteMachine.newCommand' : 'common.cancel')}
            </Button>
          )}
        </div>
      </div>
    </Card.Root>
  );
}
