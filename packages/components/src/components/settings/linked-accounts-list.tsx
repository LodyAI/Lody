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
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { CompactSection } from './compact-layout';
import { settingsSurface } from './surface';
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
  const boundProviders = new Set(accounts.map((account) => account.providerId));

  const providerLabel = useProviderLabel();

  if (loading) {
    return (
      <div {...withClassName(stylex.props(styles.loading), className)}>
        <Spinner size="small" />
        {t('settings.profile.bindings.loading')}
      </div>
    );
  }

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

      <ConnectAccountDialog
        providerId={pendingProviderId}
        onClose={() => setPendingProviderId(null)}
        onConnect={onConnect}
      />
    </>
  );
}

function useProviderLabel() {
  const { t } = useTranslation();
  return (providerId: string): string =>
    t(
      `settings.profile.providers.${providerId}`,
      providerId.charAt(0).toUpperCase() + providerId.slice(1)
    );
}

/** Asks before handing the page to a provider's OAuth flow. */
function ConnectAccountDialog({
  providerId,
  onClose,
  onConnect,
}: {
  providerId: string | null;
  onClose: () => void;
  onConnect?: (providerId: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const providerLabel = useProviderLabel();
  const [isConnecting, setIsConnecting] = useState(false);
  const label = providerId ? providerLabel(providerId) : '';

  const handleConfirm = async () => {
    if (!providerId || !onConnect) return;
    setIsConnecting(true);
    try {
      // Usually redirects to the provider's OAuth flow (navigates away).
      await onConnect(providerId);
      onClose();
    } catch (err) {
      toast.error(t('settings.profile.bindings.connectFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <Dialog.Root
      open={providerId !== null}
      onOpenChange={(open) => {
        if (isConnecting) return;
        if (!open) onClose();
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>
            {t('settings.profile.bindings.connectTitle', { provider: label })}
          </Dialog.Title>
          <Dialog.Description>
            {t('settings.profile.bindings.connectDescription', { provider: label })}
          </Dialog.Description>
        </Dialog.Header>
        <Dialog.Footer>
          <Button variant="secondary" size="small" onClick={onClose} disabled={isConnecting}>
            {t('common.cancel')}
          </Button>
          <Button
            size="small"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={isConnecting}
          >
            {isConnecting ? <Spinner size="small" /> : null}
            {t('settings.profile.bindings.connectConfirm')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

const sectionStyles = stylex.create({
  /** One provider: its mark and name, whether it is connected, and connecting it. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    minHeight: '36px',
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  mark: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
  },
  markIcon: { width: '18px', height: '18px' },
  text: { flexGrow: 1, minWidth: 0 },
  name: { margin: 0, lineHeight: type.leading, color: colors.label },
  meta: {
    margin: 0,
    fontSize: type.caption,
    lineHeight: type.leading,
    color: colors.secondaryLabel,
  },
  note: { display: 'flex', alignItems: 'center', gap: space[2] },
});

/**
 * The desktop Account page's connected accounts: a card of every provider a
 * person can sign in with, each saying whether — and since when — it is
 * connected, with a Connect button on the ones that are not.
 */
export function LinkedAccountsSection({
  accounts,
  loading = false,
  onConnect,
}: Omit<LinkedAccountsListProps, 'className'>) {
  const { t, i18n } = useTranslation();
  const providerLabel = useProviderLabel();
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const boundById = new Map(accounts.map((account) => [account.providerId, account]));
  const dateFormat = new Intl.DateTimeFormat(toIntlLocaleOrEn(i18n.language), {
    dateStyle: 'medium',
  });

  const connectedSince = (account: LinkedAccountInfo): string => {
    const date = account.createdAt == null ? null : new Date(account.createdAt);
    return date && Number.isFinite(date.getTime())
      ? t('settings.profile.bindings.connectedOn', { date: dateFormat.format(date) })
      : t('settings.profile.bindings.connectedShort');
  };

  return (
    <>
      <CompactSection title={t('settings.profile.bindings.label')} boxed>
        {loading ? (
          <p {...stylex.props(settingsSurface.cardNote, sectionStyles.note)}>
            <Spinner size="small" />
            {t('settings.profile.bindings.loading')}
          </p>
        ) : (
          PROVIDERS.map(({ id, Icon, tone }) => {
            const account = boundById.get(id);
            return (
              <div key={id} {...stylex.props(sectionStyles.row)}>
                <span aria-hidden {...stylex.props(sectionStyles.mark, tone && BOUND_TONES[tone])}>
                  <Icon {...stylex.props(sectionStyles.markIcon)} />
                </span>
                <div {...stylex.props(sectionStyles.text)}>
                  <p {...stylex.props(sectionStyles.name)}>{providerLabel(id)}</p>
                  <p {...stylex.props(sectionStyles.meta)}>
                    {account
                      ? connectedSince(account)
                      : t('settings.profile.bindings.notConnectedShort')}
                  </p>
                </div>
                {!account && onConnect ? (
                  <Button variant="secondary" size="small" onClick={() => setPendingProviderId(id)}>
                    {t('settings.profile.bindings.connectButton')}
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </CompactSection>
      <ConnectAccountDialog
        providerId={pendingProviderId}
        onClose={() => setPendingProviderId(null)}
        onConnect={onConnect}
      />
    </>
  );
}
