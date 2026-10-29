import * as stylex from '@stylexjs/stylex';
import { pageSurface as surface } from './surface';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';

import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Card } from '@/ui/card';
import { Field as UiField } from '@lody/ui/field';
import { PasswordInput } from '@lody/ui/password-input';

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
    <div {...stylex.props(surface.page)}>
      <Card.Root {...stylex.props(surface.card)}>
        <Card.Header {...stylex.props(surface.center)}>
          <div {...stylex.props(surface.centeredRow, surface.stack4)}>
            <div {...stylex.props(surface.iconWell)}>
              <KeyRound {...stylex.props(surface.heroIcon)} aria-hidden="true" />
            </div>
          </div>
          <div>
            <Card.Title
              id="reset-password-title"
              as="h1"
              className={`text-2xl font-semibold tracking-tight ${stylex.props(surface.stack1).className}`}
            >
              {t('resetPassword.title', 'Choose a new password')}
            </Card.Title>
            <Card.Description>
              {t(
                'resetPassword.description',
                'Use at least 8 characters. You can sign in after resetting your password.'
              )}
            </Card.Description>
          </div>
        </Card.Header>
        <Card.Content>
          <form
            onSubmit={onSubmit}
            {...stylex.props(surface.form)}
            aria-labelledby="reset-password-title"
            aria-describedby={submitError ? 'reset-password-error' : undefined}
            aria-busy={submitting}
          >
            {!tokenAvailable ? (
              <Alert.Root tone="danger">
                <Alert.Description>
                  {t(
                    'resetPassword.missingToken',
                    'This reset link is missing a token. Request a new password reset email.'
                  )}
                </Alert.Description>
              </Alert.Root>
            ) : null}

            {success ? (
              <Alert.Root tone="success">
                <Alert.Description>
                  {t('resetPassword.success', 'Password reset. You can now sign in.')}
                </Alert.Description>
              </Alert.Root>
            ) : null}

            <div {...stylex.props(surface.field)}>
              <UiField.Label htmlFor="reset-password-new">
                {t('resetPassword.passwordLabel', 'New password')}
              </UiField.Label>
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
                labels={{
                  show: t('resetPassword.showPassword', 'Show password'),
                  hide: t('resetPassword.hidePassword', 'Hide password'),
                }}
              />
            </div>

            <div {...stylex.props(surface.field)}>
              <UiField.Label htmlFor="reset-password-confirm">
                {t('resetPassword.confirmPasswordLabel', 'Confirm password')}
              </UiField.Label>
              <PasswordInput
                id="reset-password-confirm"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => onConfirmPasswordChange(event.target.value)}
                disabled={submitting || success || !tokenAvailable}
                labels={{
                  show: t('resetPassword.showPassword', 'Show password'),
                  hide: t('resetPassword.hidePassword', 'Hide password'),
                }}
              />
            </div>

            {submitError !== null && submitError.length > 0 ? (
              <Alert.Root tone="danger">
                <Alert.Description id="reset-password-error">{submitError}</Alert.Description>
              </Alert.Root>
            ) : null}

            <Button
              type="submit"
              {...stylex.props(surface.fullWidth)}
              disabled={submitting || success || !tokenAvailable}
            >
              {submitting ? (
                <>
                  <Spinner
                    diameter="calc(var(--spacing) * 4)"
                    className={stylex.props(surface.spinnerMargin).className}
                  />
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
        </Card.Content>
      </Card.Root>
    </div>
  );
}
