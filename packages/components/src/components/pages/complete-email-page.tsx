import * as stylex from '@stylexjs/stylex';
import { pageSurface as surface } from './surface';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';

import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Card } from '@/ui/card';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';

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
    <div {...stylex.props(surface.page)}>
      <Card.Root {...stylex.props(surface.card)}>
        <Card.Header>
          <div {...stylex.props(styles.account, surface.stack4)}>
            <div {...stylex.props(styles.accountLabel)}>
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
                  <Spinner
                    diameter="calc(var(--spacing) * 4)"
                    className={stylex.props(surface.spinnerMargin).className}
                  />
                  {t('completeEmail.loggingOut', 'Logging out')}
                </>
              ) : (
                t('completeEmail.logout', 'Logout')
              )}
            </Button>
          </div>
          <div {...stylex.props(surface.center)}>
            <div {...stylex.props(surface.centeredRow, styles.heroSpacing)}>
              <div {...stylex.props(surface.iconWell)}>
                <Mail {...stylex.props(surface.heroIcon)} aria-hidden="true" />
              </div>
            </div>
            <Card.Title
              id="complete-email-title"
              as="h1"
              fontWeight="var(--font-weight-bold)"
              {...stylex.props(surface.stack1, surface.authTitle, styles.titleLegacy)}
            >
              {t('completeEmail.title', 'Add your email')}
            </Card.Title>
            <Card.Description>
              {t(
                'completeEmail.description',
                'Your OAuth provider did not share an email. Add one so we can finish setting up your account.'
              )}
            </Card.Description>
          </div>
        </Card.Header>
        <Card.Content>
          <form
            onSubmit={onSubmit}
            aria-labelledby="complete-email-title"
            aria-describedby={submitError ? 'complete-email-error' : undefined}
            aria-busy={submitting || signingOut}
          >
            <div {...stylex.props(surface.stack4)}>
              <UiField.Label htmlFor="email" {...stylex.props(surface.stack2)}>
                {t('completeEmail.emailLabel', 'Email address')}
              </UiField.Label>
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
              <Alert.Root tone="danger" {...stylex.props(surface.stack4)}>
                <Alert.Description id="complete-email-error">{submitError}</Alert.Description>
              </Alert.Root>
            ) : null}

            <Button
              type="submit"
              {...stylex.props(surface.fullWidth)}
              disabled={submitting || signingOut}
            >
              {submitting ? (
                <>
                  <Spinner
                    diameter="calc(var(--spacing) * 4)"
                    className={stylex.props(surface.spinnerMargin).className}
                  />
                  {t('completeEmail.saving', 'Saving email')}
                </>
              ) : (
                t('completeEmail.save', 'Save and continue')
              )}
            </Button>
          </form>
        </Card.Content>
      </Card.Root>
    </div>
  );
}

const styles = stylex.create({
  titleLegacy: { '--tw-font-weight': 'var(--font-weight-bold)' },
  heroSpacing: { marginBottom: themeSpace[4] },
  account: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  accountLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});
