import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@lody/ui/spinner';
import { toast } from '@/lib/toast';
import type { IconType } from 'react-icons';
import { SiApple, SiDiscord, SiGithub, SiGoogle } from 'react-icons/si';
import { ChevronDown } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Dialog } from '@/ui/dialog';
import { settingsType as type } from './type.stylex';

export interface LinkedAccountInfo {
  id: string;
  providerId: string;
  accountId?: string;
  createdAt?: string | number | Date | null;
}

interface LinkedAccountsListProps {
  accounts: LinkedAccountInfo[];
  loading?: boolean;
  className?: string;
  /**
   * Connect an unbound provider. Typically redirects to the provider's OAuth
   * flow. When provided, the unbound providers are offered in a menu (with a
   * confirm first).
   */
  onConnect?: (providerId: string) => Promise<void> | void;
}

const styles = stylex.create({
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: space[3],
    rowGap: space[1],
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  /** A connected account: its mark, then its name, in the row's value ink. */
  account: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    color: colors.label,
    whiteSpace: 'nowrap',
  },
  none: { color: colors.secondaryLabel },
  mark: { width: '14px', height: '14px', flexShrink: 0, color: colors.secondaryLabel },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
  hint: { color: colors.tertiaryLabel },
  /** A glyph inside a menu row's icon box, which sizes it. */
  glyph: { width: '100%', height: '100%' },
});

/* Every mark is the monochrome simple-icons glyph in one ink: a connected
   account reads as a word with a sign, not as a row of brand stickers, and
   what is not connected yet is an offer in a menu rather than a grayed logo. */
const PROVIDERS: { id: string; Icon: IconType }[] = [
  { id: 'github', Icon: SiGithub },
  { id: 'google', Icon: SiGoogle },
  { id: 'apple', Icon: SiApple },
  { id: 'discord', Icon: SiDiscord },
];

export function LinkedAccountsList({
  accounts,
  loading = false,
  className,
  onConnect,
}: LinkedAccountsListProps) {
  const { t } = useTranslation();
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const boundProviders = new Set(accounts.map((account) => account.providerId));

  const providerLabel = (providerId: string): string =>
    t(
      `settings.profile.providers.${providerId}`,
      providerId.charAt(0).toUpperCase() + providerId.slice(1)
    );

  const handleConfirmConnect = async () => {
    if (!pendingProviderId || !onConnect) return;
    setIsConnecting(true);
    try {
      // Usually redirects to the provider's OAuth flow (navigates away).
      await onConnect(pendingProviderId);
      setPendingProviderId(null);
    } catch (err) {
      toast.error(t('settings.profile.bindings.connectFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsConnecting(false);
    }
  };

  if (loading) {
    return (
      <div {...withClassName(stylex.props(styles.loading), className)}>
        <Spinner size="small" />
        {t('settings.profile.bindings.loading')}
      </div>
    );
  }

  const pendingLabel = pendingProviderId ? providerLabel(pendingProviderId) : '';
  const bound = PROVIDERS.filter(({ id }) => boundProviders.has(id));
  const unbound = PROVIDERS.filter(({ id }) => !boundProviders.has(id));

  return (
    <>
      <div {...withClassName(stylex.props(styles.list), className)}>
        {bound.length === 0 ? (
          <span {...stylex.props(styles.none)}>{t('settings.profile.bindings.none')}</span>
        ) : (
          bound.map(({ id, Icon }) => (
            <span key={id} {...stylex.props(styles.account)}>
              <Icon aria-hidden {...stylex.props(styles.mark)} />
              {providerLabel(id)}
            </span>
          ))
        )}
        {onConnect && unbound.length > 0 ? (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button type="button" variant="ghost" size="small">
                  {t('settings.profile.bindings.connectMenu')}
                  <ChevronDown {...stylex.props(styles.icon, styles.hint)} />
                </Button>
              }
            />
            <Menu.Content align="end">
              {unbound.map(({ id, Icon }) => (
                <Menu.Item
                  key={id}
                  icon={<Icon aria-hidden {...stylex.props(styles.glyph)} />}
                  onClick={() => setPendingProviderId(id)}
                >
                  {t('settings.profile.bindings.connectAction', { provider: providerLabel(id) })}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Root>
        ) : null}
      </div>

      <Dialog.Root
        open={pendingProviderId !== null}
        onOpenChange={(open) => {
          if (isConnecting) return;
          if (!open) setPendingProviderId(null);
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>
              {t('settings.profile.bindings.connectTitle', { provider: pendingLabel })}
            </Dialog.Title>
            <Dialog.Description>
              {t('settings.profile.bindings.connectDescription', { provider: pendingLabel })}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button
              variant="secondary"
              size="small"
              onClick={() => setPendingProviderId(null)}
              disabled={isConnecting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="small"
              onClick={() => {
                void handleConfirmConnect();
              }}
              disabled={isConnecting}
            >
              {isConnecting ? <Spinner size="small" /> : null}
              {t('settings.profile.bindings.connectConfirm')}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
