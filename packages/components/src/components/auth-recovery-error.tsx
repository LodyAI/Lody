import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { useAuthSignOut } from '../providers/convex-provider';

export function AuthRecoveryErrorView({
  onRetry,
  onSignOut,
}: {
  onRetry: () => void;
  onSignOut: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [signingOut, setSigningOut] = useState(false);
  return (
    <AlertDialog.Root open>
      <AlertDialog.Content>
        <AlertDialog.Header>
          <AlertDialog.Title>{t('authRecovery.failedTitle')}</AlertDialog.Title>
          <AlertDialog.Description>{t('authRecovery.failedDescription')}</AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
          <Button variant="secondary" disabled={signingOut} onClick={onRetry}>
            {t('authRecovery.retry')}
          </Button>
          <Button
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void onSignOut().finally(() => setSigningOut(false));
            }}
          >
            {t('authRecovery.signInAgain')}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

export function AuthRecoveryError({ onRetry }: { onRetry: () => void }) {
  const signOut = useAuthSignOut();
  return <AuthRecoveryErrorView onRetry={onRetry} onSignOut={signOut} />;
}
