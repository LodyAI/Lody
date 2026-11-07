import { pageSurface as surface } from './surface';
import type { FormEvent } from 'react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Terminal } from 'lucide-react';

import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { SecondaryPage } from '@/components/pages/secondary-page';

export interface DeviceAuthPageProps {
  userLabel: string;
  userCode: string;
  error?: string | null;
  success?: boolean;
  countdown?: number;
  isVerifying?: boolean;
  canSubmit?: boolean;
  onUserCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const digitEnter = stylex.keyframes({
  from: { opacity: 0, filter: 'blur(3px)', transform: 'translateY(35%) scale(0.88)' },
  to: { opacity: 1, filter: 'blur(0)', transform: 'translateY(0) scale(1)' },
});

const checking = stylex.keyframes({
  '0%, 100%': { transform: 'scale(1)' },
  '50%': { transform: 'scale(0.92)' },
});

const shake = stylex.keyframes({
  '0%, 100%': { transform: 'translateX(0)' },
  '20%, 60%': { transform: 'translateX(-3px)' },
  '40%, 80%': { transform: 'translateX(3px)' },
});

const blink = stylex.keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.2 },
});

const styles = stylex.create({
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
  },
  label: {
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    color: colors.label,
  },
  codeRow: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    width: '100%',
    cursor: 'text',
  },
  codeRowInvalid: {
    animationName: { default: shake, [REDUCED_MOTION]: 'none' },
    animationDuration: '460ms',
    animationTimingFunction: ease.standard,
  },
  slot: {
    boxSizing: 'border-box',
    display: 'flex',
    flex: '1 1 0',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minWidth: 0,
    height: 44,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    color: colors.label,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 21,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  slotActive: {
    backgroundColor: colors.raisedBackground,
  },
  slotFocused: {
    boxShadow: `0 0 0 2px ${colors.accent}, ${shadow.inset}`,
  },
  slotInvalid: {
    boxShadow: `0 0 0 1px ${colors.destructive}, ${shadow.inset}`,
    color: colors.destructive,
  },
  digit: {
    animationName: { default: digitEnter, [REDUCED_MOTION]: 'none' },
    animationDuration: '260ms',
    animationTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
    animationFillMode: 'both',
  },
  digitChecking: {
    animationName: { default: checking, [REDUCED_MOTION]: 'none' },
    animationDuration: '720ms',
    animationTimingFunction: ease.standard,
    animationIterationCount: 'infinite',
  },
  caret: {
    width: 2,
    height: 19,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: { default: blink, [REDUCED_MOTION]: 'none' },
    animationDuration: '900ms',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
  separator: {
    flex: '0 0 12px',
    color: colors.tertiaryLabel,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    textAlign: 'center',
    userSelect: 'none',
  },
  hint: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
});

export function DeviceAuthPage({
  userLabel,
  userCode,
  error = null,
  success = false,
  countdown = 10,
  isVerifying = false,
  canSubmit = false,
  onUserCodeChange,
  onSubmit,
}: DeviceAuthPageProps) {
  const { t } = useTranslation();
  const headingId = 'device-auth-title';
  const mark = <Terminal size={22} strokeWidth={1.6} aria-hidden="true" />;
  const markLabel = t('device.markLabel', 'Terminal and Lody');
  const code = userCode
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toUpperCase();
  const hasError = error !== null && error.length > 0;
  const [focused, setFocused] = useState(false);

  if (success) {
    return (
      <SecondaryPage
        state="done"
        from={mark}
        markLabel={markLabel}
        title={t('device.success')}
        description={t('device.windowHint')}
        note={t('device.redirectCountdown', { seconds: countdown })}
      />
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-busy={isVerifying}
      aria-labelledby={headingId}
      aria-describedby={hasError ? 'device-auth-error' : 'device-auth-code-hint'}
    >
      <SecondaryPage
        state={isVerifying ? 'arrive' : 'ask'}
        from={mark}
        markLabel={markLabel}
        headingId={headingId}
        title={t('device.title')}
        description={t('device.description')}
        note={userLabel}
        actions={
          <Button type="submit" size="large" disabled={!canSubmit || isVerifying}>
            {isVerifying ? (
              <>
                <Spinner
                  diameter="calc(var(--spacing) * 4)"
                  className={stylex.props(surface.spinnerMargin).className}
                />
                {t('device.verifying')}
              </>
            ) : (
              t('device.verifyButton')
            )}
          </Button>
        }
      >
        <div {...stylex.props(styles.field)}>
          <label htmlFor="code" {...stylex.props(styles.label)}>
            {t('device.verificationCode')}
          </label>
          <div {...stylex.props(styles.codeRow, hasError && styles.codeRowInvalid)}>
            {Array.from({ length: 8 }, (_, index) => {
              const digit = code[index];
              const slot = (
                <span
                  key={index}
                  {...stylex.props(
                    styles.slot,
                    index === Math.min(code.length, 7) && !isVerifying && styles.slotActive,
                    focused && index === Math.min(code.length, 7) && styles.slotFocused,
                    hasError && styles.slotInvalid
                  )}
                  aria-hidden="true"
                >
                  {digit ? (
                    <span
                      key={`${index}-${digit}`}
                      {...stylex.props(styles.digit, isVerifying && styles.digitChecking)}
                      style={isVerifying ? { animationDelay: `${index * 110}ms` } : undefined}
                    >
                      {digit}
                    </span>
                  ) : null}
                  {focused && index === Math.min(code.length, 7) && !isVerifying ? (
                    <span {...stylex.props(styles.caret)} />
                  ) : null}
                </span>
              );
              return index === 3
                ? [
                    slot,
                    <span key="separator" {...stylex.props(styles.separator)} aria-hidden="true">
                      -
                    </span>,
                  ]
                : slot;
            })}
            <Input
              id="code"
              type="text"
              aria-label={t('device.verificationCode')}
              aria-invalid={hasError}
              placeholder={t('device.codePlaceholder')}
              value={userCode}
              onChange={(event) => {
                onUserCodeChange(
                  event.target.value
                    .replace(/[^a-zA-Z0-9]/g, '')
                    .slice(0, 8)
                    .toUpperCase()
                );
              }}
              required
              maxLength={9}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              disabled={isVerifying}
              autoFocus
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                position: 'absolute',
                zIndex: 1,
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0,
                cursor: 'text',
              }}
            />
          </div>
          <p id="device-auth-code-hint" {...stylex.props(styles.hint)}>
            {t('device.codeHint')}
          </p>
        </div>
        {hasError ? (
          <Alert.Root tone="danger">
            <Alert.Description id="device-auth-error">{error}</Alert.Description>
          </Alert.Root>
        ) : null}
      </SecondaryPage>
    </form>
  );
}
