import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Mail } from 'lucide-react';

import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@lody/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';

export interface CompleteEmailPageProps {
  userLabel: string;
  email: string;
  submitError?: string | null;
  submitting?: boolean;
  signingOut?: boolean;
  onEmailChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSignOut: () => void;
}

export function CompleteEmailPage({
  userLabel,
  email,
  submitError = null,
  submitting = false,
  signingOut = false,
  onEmailChange,
  onSubmit,
  onSignOut,
}: CompleteEmailPageProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <div className="min-w-0 truncate">
              {t('completeEmail.signedInAs', 'Signed in as')}: {userLabel}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={onSignOut}
              disabled={signingOut || submitting}
            >
              {signingOut ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('completeEmail.loggingOut', 'Logging out')}
                </>
              ) : (
                t('completeEmail.logout', 'Logout')
              )}
            </Button>
          </div>
          <div className="space-y-1 text-center">
            <div className="mb-4 flex justify-center">
              <div className="rounded-full bg-primary/10 p-3">
                <Mail className="h-6 w-6 text-primary" aria-hidden="true" />
              </div>
            </div>
            <CardTitle id="complete-email-title" as="h1" className="text-2xl font-bold">
              {t('completeEmail.title', 'Add your email')}
            </CardTitle>
            <CardDescription>
              {t(
                'completeEmail.description',
                'Your OAuth provider did not share an email. Add one so we can finish setting up your account.'
              )}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onSubmit}
            className="space-y-4"
            aria-labelledby="complete-email-title"
            aria-describedby={submitError ? 'complete-email-error' : undefined}
            aria-busy={submitting || signingOut}
          >
            <div className="space-y-2">
              <Label htmlFor="email">{t('completeEmail.emailLabel', 'Email address')}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                placeholder={t('completeEmail.emailPlaceholder', 'you@example.com')}
                value={email}
                onChange={(event) => onEmailChange(event.target.value)}
                disabled={submitting || signingOut}
              />
            </div>

            {submitError ? (
              <Alert variant="destructive">
                <AlertDescription id="complete-email-error">{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting || signingOut}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('completeEmail.saving', 'Saving email')}
                </>
              ) : (
                t('completeEmail.save', 'Save and continue')
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
