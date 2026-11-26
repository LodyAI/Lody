import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { StatusPage, StatusPageActions, StatusPageFootnote } from '@/components/status-page';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  quietLink: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    boxShadow: 'none',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    fontWeight: 500,
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    textDecorationLine: 'underline',
    textDecorationColor: `color-mix(in oklab, transparent, ${colors.secondaryLabel} 50%)`,
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },
  dialogError: {
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 8%)`,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.destructive,
  },
});

type Runtime = Pick<E2eeWorkspaceRuntime, 'resetIdentity' | 'resetLocalAgent'>;

/** Recovery changes local custody only. Existing pins and ledger progress remain
 * intact; a later normal pairing still requires another authorized device. */
export function E2eeIdentityRecovery({
  error,
  runtime,
  workspaceId,
  machine,
  layout = 'pane',
  onReset,
}: {
  error: string;
  runtime: Runtime;
  workspaceId: string;
  machine?: boolean;
  layout?: 'pane' | 'region';
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState<'workspace' | 'account' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  // An uncertain response retries the same reset, never archives a newer identity.
  const resetIds = useRef(new Map<string, string>());
  const code =
    /\be2ee_(?:machine_)?(permissions|custody_unavailable|unavailable|basic-text|identity-lost|corrupt|conflict|missing-binding|rewrap-failed|local-history-recovery-required|trusted-pin-unavailable|restart-required)\b/.exec(
      error
    )?.[1] ?? '';
  const permissions = code === 'permissions';
  const restart = code === 'restart-required';
  const history = code === 'local-history-recovery-required';
  const pin = code === 'trusted-pin-unavailable';
  const locked = ['custody_unavailable', 'unavailable', 'basic-text'].includes(code);
  const lost = [
    'identity-lost',
    'corrupt',
    'conflict',
    'missing-binding',
    'rewrap-failed',
    'local-history-recovery-required',
    'trusted-pin-unavailable',
  ].includes(code);
  if (!permissions && !locked && !lost && !restart) return null;
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
  const title = t(
    restart
      ? 'e2ee.identity.restartTitle'
      : history
        ? 'e2ee.identity.historyTitle'
        : pin
          ? 'e2ee.identity.pinTitle'
          : permissions
            ? 'e2ee.identity.permissionsTitle'
            : locked
              ? 'e2ee.identity.lockedTitle'
              : 'e2ee.identity.lostTitle'
  );
  const description = t(
    restart
      ? 'e2ee.identity.restartHelp'
      : history
        ? 'e2ee.identity.historyHelp'
        : pin
          ? 'e2ee.identity.pinHelp'
          : permissions
            ? 'e2ee.identity.permissionsHelp'
            : locked
              ? 'e2ee.identity.lockedHelp'
              : 'e2ee.identity.lostHelp'
  );
  const canResetAccount =
    !restart && !machine && (locked || lost) && Boolean(runtime.resetIdentity);

  return (
    <StatusPage
      layout={layout}
      role="alert"
      illustration="broken"
      title={title}
      description={description}
    >
      {!restart && (
        <StatusPageActions>
          <Button type="button" size="small" variant="primary" disabled={busy} onClick={onReset}>
            {t('common.retry')}
          </Button>
          {reset && !permissions && (
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setFailure(false);
                setConfirm('workspace');
              }}
            >
              {t(machine ? 'e2ee.identity.resetMachine' : 'e2ee.identity.resetWorkspace')}
            </Button>
          )}
        </StatusPageActions>
      )}

      {canResetAccount && (
        <StatusPageFootnote>
          <button
            type="button"
            disabled={busy}
            {...stylex.props(styles.quietLink)}
            onClick={() => {
              setFailure(false);
              setConfirm('account');
            }}
          >
            {t('e2ee.identity.resetAccount')}
          </button>
        </StatusPageFootnote>
      )}

      <AlertDialog.Root
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirm(null);
            setFailure(false);
          }
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t(
                confirm === 'account'
                  ? 'e2ee.identity.resetAccount'
                  : machine
                    ? 'e2ee.identity.resetMachine'
                    : 'e2ee.identity.resetWorkspace'
              )}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                confirm === 'account'
                  ? 'e2ee.identity.accountWarning'
                  : 'e2ee.identity.resetWarning'
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          {failure && (
            <p role="alert" {...stylex.props(styles.dialogError)}>
              {t('e2ee.identity.resetFailed')}
            </p>
          )}
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button disabled={busy} variant="destructive" onClick={() => void apply()}>
              {t('e2ee.identity.confirm')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </StatusPage>
  );
}
