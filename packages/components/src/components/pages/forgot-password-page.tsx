import * as stylex from '@stylexjs/stylex';
import { pageSurface as surface } from './surface';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';

import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Card } from '@/ui/card';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';

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
    <div {...stylex.props(surface.page)}>
      <Card.Root {...stylex.props(surface.card)}>
        <Card.Header {...stylex.props(surface.center)}>
          <div {...stylex.props(surface.centeredRow, surface.stack4)}>
            <div {...stylex.props(surface.iconWell)}>
              <Mail {...stylex.props(surface.heroIcon)} aria-hidden="true" />
            </div>
          </div>
          <div>
            <Card.Title
              id="forgot-password-title"
              as="h1"
              fontWeight="var(--font-weight-semibold)"
              letterSpacing="var(--tracking-tight)"
              {...stylex.props(surface.stack1, surface.authTitle, styles.titleLegacy)}
            >
              {t('forgotPassword.title', 'Reset your password')}
            </Card.Title>
            <Card.Description>
              {t(
                'forgotPassword.description',
                'Enter your account email and we will send you a password reset link.'
              )}
            </Card.Description>
          </div>
        </Card.Header>
        <Card.Content>
          <form
            onSubmit={onSubmit}
            {...stylex.props(surface.form)}
            aria-labelledby="forgot-password-title"
            aria-describedby={submitError ? 'forgot-password-error' : undefined}
            aria-busy={submitting}
          >
            <div {...stylex.props(surface.field)}>
              <UiField.Label htmlFor="forgot-password-email">
                {t('forgotPassword.emailLabel', 'Email address')}
              </UiField.Label>
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
              <Alert.Root tone="success">
                <Alert.Description>
                  {t(
                    'forgotPassword.sent',
                    'If an account exists for this email, a reset link has been sent.'
                  )}
                </Alert.Description>
              </Alert.Root>
            ) : null}

            {submitError !== null && submitError.length > 0 ? (
              <Alert.Root tone="danger">
                <Alert.Description id="forgot-password-error">{submitError}</Alert.Description>
              </Alert.Root>
            ) : null}

            <Button type="submit" {...stylex.props(surface.fullWidth)} disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner
                    diameter="calc(var(--spacing) * 4)"
                    className={stylex.props(surface.spinnerMargin).className}
                  />
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
        </Card.Content>
      </Card.Root>
    </div>
  );
}

const styles = stylex.create({
  titleLegacy: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    '--tw-tracking': 'var(--tracking-tight)',
  },
});
