import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { IconType } from 'react-icons';
import { SiApple, SiDiscord, SiGithub } from 'react-icons/si';
import { FcGoogle } from 'react-icons/fc';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';

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

/* Brand marks are sized on a shared grid so they read at the same optical size.
   Monochrome simple-icons tint via `text-*` (foreground for GitHub/Apple so they
   stay visible in dark mode); the flat-color Google mark (`FcGoogle`) has baked
   colors, so it's grayed with a filter when unbound. */
const PROVIDERS: {
  id: string;
  Icon: IconType;
  /** Flat multi-color mark (colors baked in) → gray via filter when unbound. */
  flat?: boolean;
  boundClassName?: string;
  /** `group-hover:` variant of the brand color, applied when the mark is a
   * clickable (unbound) button so hovering previews the connected color.
   * Kept as literal strings so Tailwind's JIT emits them. */
  hoverClassName?: string;
}[] = [
  {
    id: 'github',
    Icon: SiGithub,
    boundClassName: 'text-foreground',
    hoverClassName: 'group-hover:text-foreground',
  },
  { id: 'google', Icon: FcGoogle, flat: true },
  {
    id: 'apple',
    Icon: SiApple,
    boundClassName: 'text-foreground',
    hoverClassName: 'group-hover:text-foreground',
  },
  {
    id: 'discord',
    Icon: SiDiscord,
    boundClassName: 'text-[#5865F2]',
    hoverClassName: 'group-hover:text-[#5865F2]',
  },
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

  const iconClassName = (
    bound: boolean,
    connectable: boolean,
    flat: boolean | undefined,
    boundClassName?: string,
    hoverClassName?: string
  ) =>
    cn(
      'h-5 w-5 shrink-0 transition-all',
      flat
        ? bound
          ? ''
          : connectable
            ? 'opacity-40 grayscale group-hover:opacity-100 group-hover:grayscale-0'
            : 'opacity-40 grayscale'
        : bound
          ? boundClassName
          : connectable
            ? cn('text-muted-foreground/35', hoverClassName)
            : 'text-muted-foreground/35'
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
      <div className={cn('flex items-center gap-2 text-[11px] text-muted-foreground', className)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('settings.profile.bindings.loading')}
      </div>
    );
  }

  const pendingLabel = pendingProviderId ? providerLabel(pendingProviderId) : '';

  return (
    <>
      <div className={cn('flex items-center gap-3', className)}>
        {PROVIDERS.map(({ id, Icon, flat, boundClassName, hoverClassName }) => {
          const bound = boundProviders.has(id);
          const label = providerLabel(id);
          const connectable = !bound && Boolean(onConnect);
          const icon = (
            <Icon
              aria-hidden
              className={iconClassName(bound, connectable, flat, boundClassName, hoverClassName)}
            />
          );

          if (connectable) {
            return (
              <button
                key={id}
                type="button"
                title={t('settings.profile.bindings.connectAction', { provider: label })}
                aria-label={t('settings.profile.bindings.connectAction', { provider: label })}
                onClick={() => setPendingProviderId(id)}
                className="group cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {icon}
              </button>
            );
          }

          return (
            <span
              key={id}
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

      <Dialog
        open={pendingProviderId !== null}
        onOpenChange={(open) => {
          if (isConnecting) return;
          if (!open) setPendingProviderId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings.profile.bindings.connectTitle', { provider: pendingLabel })}
            </DialogTitle>
            <DialogDescription>
              {t('settings.profile.bindings.connectDescription', { provider: pendingLabel })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
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
              {isConnecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {t('settings.profile.bindings.connectConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
