import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccountProfileSummary } from '@lody/shared';
import { Button } from '@/ui/button';
export function AccountProfileList({
  profiles,
  onSignIn,
  systemDefaultAuthentication,
}: {
  profiles: AccountProfileSummary[];
  systemDefaultAuthentication?: ReactNode;
  onSignIn: (accountProfileId: string) => void;
}) {
  const { t } = useTranslation();
  const rows: AccountProfileSummary[] = profiles.length
    ? profiles
    : [
        {
          accountProfileId: 'system-default',
          label: 'System Default',
          status: 'unknown',
        },
      ];
  return (
    <>
      {rows.map((profile) => (
        <Fragment key={profile.accountProfileId}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 break-words">
              {profile.accountProfileId === 'system-default'
                ? t('agents.accounts.systemDefault', 'System Default')
                : profile.label}
              {profile.identity ? ` — ${profile.identity}` : ''}
              <span className="ml-2 text-xs text-muted-foreground">
                {profile.status === 'authenticated'
                  ? t('agents.accounts.authenticated', 'Signed in')
                  : profile.status === 'unauthenticated'
                    ? t('agents.accounts.unauthenticated', 'Sign-in required')
                    : t('agents.accounts.unknown', 'Status unavailable')}
              </span>
            </span>
            {profile.accountProfileId !== 'system-default' && (
              <Button
                className="shrink-0"
                size="sm"
                variant="ghost"
                onClick={() => onSignIn(profile.accountProfileId)}
              >
                {t('agents.accounts.signIn', 'Sign in')}
              </Button>
            )}
          </div>
          {profile.accountProfileId === 'system-default' ? systemDefaultAuthentication : null}
        </Fragment>
      ))}
    </>
  );
}
