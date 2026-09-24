import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { UserAvatar } from '@/components/user-avatar';

type SettingsAccountUser = {
  id?: string | null;
  name?: string | null;
  image?: string | null;
  email?: string | null;
};

export function SettingsAccountEntry({
  user,
  active = false,
  mobile = false,
  onSelect,
}: {
  user: SettingsAccountUser | null | undefined;
  active?: boolean;
  mobile?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  if (!user) return null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={t('settings.account.open', 'Open account settings')}
      className={cn(
        'flex w-full min-w-0 items-center text-start transition-colors',
        mobile
          ? 'gap-3 rounded-2xl border border-border/40 bg-card px-4 py-3 active:bg-muted/40'
          : 'gap-2.5 rounded-md px-2.5 py-1 hover:bg-foreground/[0.06]',
        !mobile && active && 'bg-foreground/[0.1]'
      )}
    >
      <UserAvatar
        user={user}
        className={cn(
          'shrink-0 text-xs',
          // Desktop: sized to the nav rows' 16px icons (18px, overhanging its
          // 16px slot by 1px a side) so the row keeps their 28px height and the
          // name lines up with the other labels.
          mobile ? 'h-9 w-9' : '-mx-px h-[18px] w-[18px] text-[9px]'
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-normal text-foreground">
          {user.name || user.email || t('settings.tabs.account')}
        </span>
        {mobile && user.email ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{user.email}</span>
        ) : null}
      </span>
      {mobile ? (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      ) : null}
    </button>
  );
}
