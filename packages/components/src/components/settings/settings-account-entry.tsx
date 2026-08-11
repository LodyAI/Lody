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
          : 'gap-2.5 rounded-md px-2.5 py-1 hover:bg-secondary/50',
        !mobile && active && 'bg-secondary text-secondary-foreground'
      )}
    >
      <UserAvatar
        user={user}
        className={cn(
          'shrink-0 text-xs',
          mobile ? 'h-9 w-9' : 'h-6 w-6 text-[10px]'
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
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
