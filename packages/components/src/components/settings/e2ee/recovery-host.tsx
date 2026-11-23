import * as stylex from '@stylexjs/stylex';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useContext, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as type } from '@lody/ui/tokens/scales.stylex';
import { useStableSession } from '@/hooks/useStableSession';
import { useAppCapability } from '@/lib/app-platform';
import { RecoveryVaultSection } from './recovery-vault-section';
import { E2eeRecoveryHostContext, useRecoveryPort } from './recovery-port';

export { E2eeRecoveryHostContext, type E2eeRecoveryHost } from './recovery-port';

/** The Recovery tab's content for this host: the shared section over the host's
 * recovery port (desktop's is its main-process vault), a host-owned section, or
 * undefined when the host has neither or the recovery switch is off, so the console
 * shows its own explanation instead of an empty tab. */
export function useE2eeRecoverySection(): ComponentType<{ accountId?: string | null }> | undefined {
  const host = useContext(E2eeRecoveryHostContext);
  const port = useRecoveryPort();
  if (host && 'Section' in host) return host.Section;
  return port ? RecoveryVaultSection : undefined;
}

const styles = stylex.create({
  page: {
    display: 'flex',
    justifyContent: 'center',
    minHeight: '100dvh',
    overflowY: 'auto',
    paddingBlockStart: 48,
    paddingBlockEnd: space[6],
    paddingInline: space[4],
    backgroundColor: colors.background,
    color: colors.label,
  },
  column: { display: 'flex', flexDirection: 'column', gap: space[4], width: '100%', maxWidth: 640 },
  header: { display: 'flex', alignItems: 'center', gap: space[3] },
  title: { margin: 0, fontSize: type.headlineSize, fontWeight: 600 },
  lead: { margin: 0, color: colors.secondaryLabel, fontSize: type.subheadlineSize },
});

/**
 * Account recovery outside any workspace, for a host whose recovery port is its own
 * (desktop main's vault): Settings > Account opens it through the router's
 * `recoveryPage`. It renders the same section as the encryption console's Recovery
 * tab, so it needs no encrypted workspace. Without a cloud account, a signed-in user or
 * a recovery section (switch off), it says recovery is unavailable and calls nothing.
 */
export function RecoveryAccountPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const navigate = useNavigate();
  const cloudAccount = useAppCapability('cloudAccount');
  const { data: session } = useStableSession();
  const Section = useE2eeRecoverySection();
  const accountId = session?.user?.id ?? null;
  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: '/' });
  };
  return (
    <main data-testid="recovery-account-page" {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.header)}>
          <Button variant="secondary" onClick={back}>
            {t('common.back')}
          </Button>
          <h1 {...stylex.props(styles.title)}>{t('e2ee.recovery.manage')}</h1>
        </div>
        {cloudAccount && accountId && Section ? (
          <Section key={accountId} accountId={accountId} />
        ) : (
          <p {...stylex.props(styles.lead)}>{t('e2ee.recovery.unavailable')}</p>
        )}
      </div>
    </main>
  );
}
