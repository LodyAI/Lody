import { useTranslation } from 'react-i18next';
import { MailCheck } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { SecondaryPage } from '@/components/pages/secondary-page';

export interface EmailVerifiedPageProps {
  /** The verified email address, when better-auth forwarded it in the callback. */
  email?: string;
  /** Seconds left before the page forwards to the sign-in view. */
  secondsRemaining: number;
  /** Skip the countdown and go to sign-in immediately. */
  onContinue: () => void;
}

export function EmailVerifiedPage({ email, secondsRemaining, onContinue }: EmailVerifiedPageProps) {
  const { t } = useTranslation();

  return (
    <SecondaryPage
      state="done"
      from={<MailCheck size={22} strokeWidth={1.6} aria-hidden="true" />}
      markLabel={t('emailVerified.markLabel', 'Email and Lody')}
      title={t('emailVerified.title', 'Email verified')}
      description={t('emailVerified.signInPrompt', 'You can now sign in.')}
      well={email ? <span>{email}</span> : undefined}
      actions={
        <Button type="button" size="large" onClick={onContinue}>
          {t('emailVerified.continueNow', 'Sign in now')}
        </Button>
      }
      note={t('emailVerified.redirectNotice', {
        seconds: secondsRemaining,
        defaultValue: 'Redirecting to sign in in {{seconds}}s…',
      })}
    />
  );
}
