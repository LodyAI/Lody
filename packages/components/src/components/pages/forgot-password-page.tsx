import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, Mail } from 'lucide-react';

import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@lody/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';

export interface ForgotPasswordPageProps {
  email: string;
  submitError?: string | null;
  sent?: boolean;
  submitting?: boolean;
  onEmailChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBackToLogin: () => void;
}

export function ForgotPasswordPage({
  email,
  submitError = null,
  sent = false,
  submitting = false,
  onEmailChange,
  onSubmit,
  onBackToLogin,
}: ForgotPasswordPageProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4 text-center">
          <div className="flex justify-center">
            <div className="rounded-full bg-primary/10 p-3">
              <Mail className="h-6 w-6 text-primary" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-1">
            <CardTitle
              id="forgot-password-title"
              as="h1"
              className="text-2xl font-semibold tracking-tight"
            >
              {t('forgotPassword.title', 'Reset your password')}
            </CardTitle>
            <CardDescription>
              {t(
                'forgotPassword.description',
                'Enter your account email and we will send you a password reset link.'
              )}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onSubmit}
            className="grid gap-4"
            aria-labelledby="forgot-password-title"
            aria-describedby={submitError ? 'forgot-password-error' : undefined}
            aria-busy={submitting}
          >
            <div className="grid gap-2">
              <Label htmlFor="forgot-password-email">
                {t('forgotPassword.emailLabel', 'Email address')}
              </Label>
              <Input
                id="forgot-password-email"
                type="email"
                autoComplete="email"
                required
                placeholder={t('forgotPassword.emailPlaceholder', 'you@example.com')}
                value={email}
                onChange={(event) => onEmailChange(event.target.value)}
                disabled={submitting}
              />
            </div>

            {sent ? (
              <Alert>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>
                  {t(
                    'forgotPassword.sent',
                    'If an account exists for this email, a reset link has been sent.'
                  )}
                </AlertDescription>
              </Alert>
            ) : null}

            {submitError !== null && submitError.length > 0 ? (
              <Alert variant="destructive">
                <AlertDescription id="forgot-password-error">{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('forgotPassword.sending', 'Sending reset link...')}
                </>
              ) : (
                t('forgotPassword.submit', 'Send reset link')
              )}
            </Button>

            <Button type="button" variant="ghost" onClick={onBackToLogin} disabled={submitting}>
              {t('forgotPassword.backToLogin', 'Back to login')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
