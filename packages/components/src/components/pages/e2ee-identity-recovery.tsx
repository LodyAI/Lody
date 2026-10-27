import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { Button } from '@lody/ui/button';
import { Alert } from '@lody/ui/alert';

type Runtime = Pick<E2eeWorkspaceRuntime, 'resetIdentity' | 'resetLocalAgent'>;

/** Recovery changes local custody only. Existing pins and ledger progress remain
 * intact; a later normal pairing still requires another authorized device. */
export function E2eeIdentityRecovery({
  error,
  runtime,
  workspaceId,
  machine,
  onReset,
}: {
  error: string;
  runtime: Runtime;
  workspaceId: string;
  machine?: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState<'workspace' | 'account' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  // An uncertain response retries the same reset, never archives a newer identity.
  const resetIds = useRef(new Map<string, string>());
  const code =
    /\be2ee_(?:machine_)?(permissions|custody_unavailable|unavailable|basic-text|identity-lost|corrupt|conflict|missing-binding|rewrap-failed)\b/.exec(
      error
    )?.[1] ?? '';
  const permissions = code === 'permissions';
  const locked = ['custody_unavailable', 'unavailable', 'basic-text'].includes(code);
  const lost = [
    'identity-lost',
    'corrupt',
    'conflict',
    'missing-binding',
    'rewrap-failed',
  ].includes(code);
  if (!permissions && !locked && !lost) return null;
  const reset = machine ? runtime.resetLocalAgent : runtime.resetIdentity;
  const apply = async () => {
    if (!reset || !confirm || busy) return;
    const scope = confirm;
    const resetId = resetIds.current.get(scope) ?? crypto.randomUUID();
    resetIds.current.set(scope, resetId);
    setBusy(true);
    setFailure(false);
    try {
      if (machine) await runtime.resetLocalAgent?.({ workspaceId, resetId, confirm: true });
      else
        await runtime.resetIdentity?.({
          workspaceId: scope === 'account' ? undefined : workspaceId,
          resetId,
          confirm: true,
        });
      resetIds.current.clear();
      onReset();
      setConfirm(null);
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert.Root tone="warning">
      <Alert.Title>
        {t(
          permissions
            ? 'e2ee.identity.permissionsTitle'
            : locked
              ? 'e2ee.identity.lockedTitle'
              : 'e2ee.identity.lostTitle'
        )}
      </Alert.Title>
      <Alert.Description>
        {t(
          permissions
            ? 'e2ee.identity.permissionsHelp'
            : locked
              ? 'e2ee.identity.lockedHelp'
              : 'e2ee.identity.lostHelp'
        )}
      </Alert.Description>
      {confirm && (
        <Alert.Description>
          {t(confirm === 'account' ? 'e2ee.identity.accountWarning' : 'e2ee.identity.resetWarning')}
        </Alert.Description>
      )}
      {failure && <Alert.Description>{t('e2ee.identity.resetFailed')}</Alert.Description>}
      <Alert.Actions>
        {confirm ? (
          <>
            <Button disabled={busy} variant="destructive" onClick={() => void apply()}>
              {t('e2ee.identity.confirm')}
            </Button>
            <Button disabled={busy} variant="ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onReset}>
              {t('common.tryAgain')}
            </Button>
            {reset && !permissions && (
              <Button variant="secondary" onClick={() => setConfirm('workspace')}>
                {t(machine ? 'e2ee.identity.resetMachine' : 'e2ee.identity.resetWorkspace')}
              </Button>
            )}
            {!machine && (locked || lost) && runtime.resetIdentity && (
              <Button variant="ghost" onClick={() => setConfirm('account')}>
                {t('e2ee.identity.resetAccount')}
              </Button>
            )}
          </>
        )}
      </Alert.Actions>
    </Alert.Root>
  );
}
