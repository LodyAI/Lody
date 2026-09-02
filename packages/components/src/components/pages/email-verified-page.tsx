import { useTranslation } from 'react-i18next';

import { Button } from '@lody/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import lodyLogo from '@/assets/lody-icon.png';

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
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4">
          <div className="flex justify-center">
            <img src={lodyLogo} alt="Lody" className="h-10 w-10 object-contain" draggable={false} />
          </div>
          <div className="space-y-2 text-center">
            <CardTitle className="text-2xl font-bold">
              {t('emailVerified.title', 'Email verified')}
            </CardTitle>
            {email ? (
              <p className="break-all text-sm font-medium text-foreground">{email}</p>
            ) : null}
            <CardDescription>
              {t('emailVerified.signInPrompt', 'You can now sign in.')}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            {t('emailVerified.redirectNotice', {
              seconds: secondsRemaining,
              defaultValue: 'Redirecting to sign in in {{seconds}}s…',
            })}
          </p>
          <Button type="button" className="w-full" onClick={onContinue}>
            {t('emailVerified.continueNow', 'Sign in now')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
