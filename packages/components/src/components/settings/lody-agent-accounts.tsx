import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog } from '@/ui/dialog';
import { settingsRecordsCard } from './compact-layout';

export interface LodyAgentCredential {
  providerId: string;
  type: string;
}

export interface LodyAgentAccountsProps {
  status: 'loading' | 'error' | 'unsupported' | 'ready';
  credentials: readonly LodyAgentCredential[];
  /** A user-facing, already localized error, including removal failures. */
  error?: string | null;
  removingProviderId?: string | null;
  onRefresh: () => void;
  onRemove: (credential: LodyAgentCredential) => void;
}

const styles = stylex.create({
  container: { display: 'flex', flexDirection: 'column', gap: space[2] },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  description: { margin: 0, color: colors.secondaryLabel, fontSize: text.footnoteSize },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    padding: space[3],
  },
  identity: { minWidth: 0, overflowWrap: 'anywhere' },
  error: { margin: 0, color: colors.destructive },
});

export function LodyAgentAccounts({
  status,
  credentials,
  error,
  removingProviderId,
  onRefresh,
  onRemove,
}: LodyAgentAccountsProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<LodyAgentCredential | null>(null);
  const pending = removingProviderId != null;
  return (
    <section {...stylex.props(styles.container)} aria-label={t('lodyAgentAccounts.title')}>
      <div {...stylex.props(styles.header)}>
        <strong>{t('lodyAgentAccounts.title')}</strong>
        <Button
          size="small"
          variant="secondary"
          onClick={onRefresh}
          disabled={status === 'loading' || status === 'unsupported' || pending}
        >
          {t('lodyAgentAccounts.refresh')}
        </Button>
      </div>
      <p {...stylex.props(styles.description)}>{t('lodyAgentAccounts.description')}</p>
      {status === 'loading' && <p role="status">{t('lodyAgentAccounts.loading')}</p>}
      {status === 'unsupported' && <p>{t('lodyAgentAccounts.unsupported')}</p>}
      {status === 'error' && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error || t('lodyAgentAccounts.error')}
        </p>
      )}
      {status === 'ready' && (
        <>
          {error && (
            <p role="alert" {...stylex.props(styles.error)}>
              {error}
            </p>
          )}
          {credentials.length === 0 ? (
            <p>{t('lodyAgentAccounts.empty')}</p>
          ) : (
            <div {...stylex.props(settingsRecordsCard)}>
              {credentials.map((credential) => (
                <div
                  key={JSON.stringify([credential.providerId, credential.type])}
                  {...stylex.props(styles.row)}
                >
                  <div {...stylex.props(styles.identity)}>
                    <div>{credential.providerId}</div>
                    <div {...stylex.props(styles.description)}>{credential.type}</div>
                  </div>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={pending}
                    aria-label={t('lodyAgentAccounts.removeLabel', {
                      providerId: credential.providerId,
                      type: credential.type,
                    })}
                    onClick={() => setSelected(credential)}
                  >
                    {t('lodyAgentAccounts.remove')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <AlertDialog.Root
        open={selected !== null && status === 'ready'}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('lodyAgentAccounts.confirmTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('lodyAgentAccounts.confirmDescription', {
                providerId: selected?.providerId,
                type: selected?.type,
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={pending}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              disabled={
                pending ||
                !selected ||
                !credentials.some(
                  (item) => item.providerId === selected.providerId && item.type === selected.type
                )
              }
              onClick={() => {
                if (selected) {
                  onRemove(selected);
                  setSelected(null);
                }
              }}
            >
              {t('lodyAgentAccounts.remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </section>
  );
}
