import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@lody/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Label } from '@/ui/label';
import { PasswordInput } from '@/ui/password-input';

export interface ResetPasswordPageProps {
  password: string;
  confirmPassword: string;
  submitError?: string | null;
  success?: boolean;
  submitting?: boolean;
  tokenAvailable?: boolean;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBackToLogin: () => void;
}

export function ResetPasswordPage({
  password,
  confirmPassword,
  submitError = null,
  success = false,
  submitting = false,
  tokenAvailable = true,
  onPasswordChange,
  onConfirmPasswordChange,
  onSubmit,
  onBackToLogin,
}: ResetPasswordPageProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-4 text-center">
          <div className="flex justify-center">
            <div className="rounded-full bg-primary/10 p-3">
              <KeyRound className="h-6 w-6 text-primary" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-1">
            <CardTitle
              id="reset-password-title"
              as="h1"
              className="text-2xl font-semibold tracking-tight"
            >
              {t('resetPassword.title', 'Choose a new password')}
            </CardTitle>
            <CardDescription>
              {t(
                'resetPassword.description',
                'Use at least 8 characters. You can sign in after resetting your password.'
              )}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={onSubmit}
            className="grid gap-4"
            aria-labelledby="reset-password-title"
            aria-describedby={submitError ? 'reset-password-error' : undefined}
            aria-busy={submitting}
          >
            {!tokenAvailable ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {t(
                    'resetPassword.missingToken',
                    'This reset link is missing a token. Request a new password reset email.'
                  )}
                </AlertDescription>
              </Alert>
            ) : null}

            {success ? (
              <Alert>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>
                  {t('resetPassword.success', 'Password reset. You can now sign in.')}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="reset-password-new">
                {t('resetPassword.passwordLabel', 'New password')}
              </Label>
              <PasswordInput
                id="reset-password-new"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                disabled={submitting || success || !tokenAvailable}
                placeholder={t(
                  'resetPassword.passwordPlaceholder',
                  'Letters and numbers, 8+ characters'
                )}
                showPasswordLabel={t('resetPassword.showPassword', 'Show password')}
                hidePasswordLabel={t('resetPassword.hidePassword', 'Hide password')}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="reset-password-confirm">
                {t('resetPassword.confirmPasswordLabel', 'Confirm password')}
              </Label>
              <PasswordInput
                id="reset-password-confirm"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => onConfirmPasswordChange(event.target.value)}
                disabled={submitting || success || !tokenAvailable}
                showPasswordLabel={t('resetPassword.showPassword', 'Show password')}
                hidePasswordLabel={t('resetPassword.hidePassword', 'Hide password')}
              />
            </div>

            {submitError !== null && submitError.length > 0 ? (
              <Alert variant="destructive">
                <AlertDescription id="reset-password-error">{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || success || !tokenAvailable}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('resetPassword.saving', 'Saving password...')}
                </>
              ) : (
                t('resetPassword.submit', 'Reset password')
              )}
            </Button>

            <Button type="button" variant="ghost" onClick={onBackToLogin} disabled={submitting}>
              {t('resetPassword.backToLogin', 'Back to login')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
