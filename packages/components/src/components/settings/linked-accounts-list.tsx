import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@lody/ui/spinner';
import { toast } from '@/lib/toast';
import type { IconType } from 'react-icons';
import { SiApple, SiDiscord, SiGithub } from 'react-icons/si';
import { FcGoogle } from 'react-icons/fc';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
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
   * flow. When provided, unbound logos become clickable (with a confirm first).
   */
  onConnect?: (providerId: string) => Promise<void> | void;
}

const styles = stylex.create({
  list: { display: 'flex', alignItems: 'center', gap: space[3] },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  /**
   * The box a mark sits in; the mark takes its colour from it, so a connectable
   * mark previews its connected colour under the pointer by the box's own hover.
   */
  mark: {
    display: 'inline-flex',
    flexShrink: 0,
    padding: 0,
    margin: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    transitionProperty: 'color, opacity, filter',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  pressable: {
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
  },
  icon: { width: '20px', height: '20px', flexShrink: 0 },
  /** An unbound monochrome mark is a hint. */
  unbound: { color: colors.tertiaryLabel },
  /** A flat multi-colour mark has its colours baked in, so it is grayed instead. */
  flatUnbound: { opacity: 0.4, filter: 'grayscale(1)' },
  flatUnboundConnectable: {
    opacity: { default: 0.4, ':hover': 1 },
    filter: { default: 'grayscale(1)', ':hover': 'none' },
  },
  ink: { color: colors.label },
  inkConnectable: { color: { default: colors.tertiaryLabel, ':hover': colors.label } },
  discord: { color: '#5865F2' },
  discordConnectable: { color: { default: colors.tertiaryLabel, ':hover': '#5865F2' } },
});

type BrandTone = 'ink' | 'discord';

/* Brand marks are sized on a shared grid so they read at the same optical size.
   Monochrome simple-icons draw in `currentColor` (the label ink for GitHub/Apple
   so they stay visible in dark mode); the flat-colour Google mark (`FcGoogle`)
   has baked colours, so it's grayed with a filter when unbound. */
const PROVIDERS: {
  id: string;
  Icon: IconType;
  /** Flat multi-color mark (colors baked in) → gray via filter when unbound. */
  flat?: boolean;
  /** The brand colour a bound (or hovered, connectable) monochrome mark takes. */
  tone?: BrandTone;
}[] = [
  { id: 'github', Icon: SiGithub, tone: 'ink' },
  { id: 'google', Icon: FcGoogle, flat: true },
  { id: 'apple', Icon: SiApple, tone: 'ink' },
  { id: 'discord', Icon: SiDiscord, tone: 'discord' },
];

const BOUND_TONES = { ink: styles.ink, discord: styles.discord } as const;
const CONNECTABLE_TONES = {
  ink: styles.inkConnectable,
  discord: styles.discordConnectable,
} as const;

function markStyle(bound: boolean, connectable: boolean, flat?: boolean, tone?: BrandTone) {
  if (flat) {
    if (bound) return null;
    return connectable ? styles.flatUnboundConnectable : styles.flatUnbound;
  }
  if (bound) return tone ? BOUND_TONES[tone] : null;
  return connectable && tone ? CONNECTABLE_TONES[tone] : styles.unbound;
}

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

  return (
    <>
      <div {...withClassName(stylex.props(styles.list), className)}>
        {PROVIDERS.map(({ id, Icon, flat, tone }) => {
          const bound = boundProviders.has(id);
          const label = providerLabel(id);
          const connectable = !bound && Boolean(onConnect);
          const mark = markStyle(bound, connectable, flat, tone);
          const icon = <Icon aria-hidden {...stylex.props(styles.icon)} />;

          if (connectable) {
            return (
              <button
                key={id}
                type="button"
                title={t('settings.profile.bindings.connectAction', { provider: label })}
                aria-label={t('settings.profile.bindings.connectAction', { provider: label })}
                onClick={() => setPendingProviderId(id)}
                {...stylex.props(styles.mark, styles.pressable, mark)}
              >
                {icon}
              </button>
            );
          }

          return (
            <span
              key={id}
              {...stylex.props(styles.mark, mark)}
              title={
                bound
                  ? t('settings.profile.bindings.connected', { provider: label })
                  : t('settings.profile.bindings.notConnected', { provider: label })
              }
              aria-label={
                bound
                  ? t('settings.profile.bindings.connected', { provider: label })
                  : t('settings.profile.bindings.notConnected', { provider: label })
              }
            >
              {icon}
            </span>
          );
        })}
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
