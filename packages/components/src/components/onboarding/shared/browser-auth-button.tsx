import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  CHECK_DRAW_S,
  EASE_OUT,
  HOLD_SUCCESS_MS,
  SPRING_CHIP,
  useOnboardingReducedMotion,
  useOnlineStatus,
} from '../motion-tokens';
import { flatSurface } from './flat-surface.stylex';

export type BrowserAuthPhase = 'idle' | 'waiting' | 'success';

const styles = stylex.create({
  primaryWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.75rem',
  },
  primaryBtn: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '12px',
    backgroundColor: 'var(--flat-primary-bg)',
    color: 'var(--flat-primary-fg)',
    fontSize: '0.9375rem',
    fontWeight: 500,
    lineHeight: 1.2,
    minHeight: '2.75rem',
    paddingBlock: '0.75rem',
    paddingInline: '1.25rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'background-color, opacity, transform',
    transitionDuration: '140ms, 140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-primary-hover)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':disabled': {
      cursor: 'default',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  primaryBtnOffline: {
    backgroundColor: 'var(--flat-fill-strong)',
    color: 'var(--flat-ink-tertiary)',
    ':hover': {
      backgroundColor: 'var(--flat-fill-strong)',
    },
    ':active': {
      transform: 'none',
    },
  },
  primaryBtnWaiting: {
    backgroundColor: 'var(--flat-fill-hover)',
    color: 'var(--flat-ink)',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
    },
    ':active': {
      transform: 'none',
    },
  },
  primaryBtnSuccess: {
    backgroundColor: 'var(--flat-ok-bg)',
    color: 'var(--flat-ok-fg)',
    ':hover': {
      backgroundColor: 'var(--flat-ok-bg)',
    },
    ':active': {
      transform: 'none',
    },
  },
  tile: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '12px',
    backgroundColor: 'var(--flat-fill)',
    color: 'var(--flat-ink)',
    width: '100%',
    minHeight: '4.125rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.875rem',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    alignItems: 'stretch',
    gap: '0.375rem',
    cursor: 'pointer',
    textAlign: 'start',
    userSelect: 'none',
    transitionProperty: 'background-color, opacity, transform',
    transitionDuration: '140ms, 140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':disabled': {
      cursor: 'default',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  tileWaiting: {
    backgroundColor: 'var(--flat-fill-hover)',
    cursor: 'default',
    ':active': {
      transform: 'none',
    },
  },
  tileSuccess: {
    backgroundColor: 'var(--flat-ok-bg)',
    color: 'var(--flat-ok-fg)',
    cursor: 'default',
    ':hover': {
      backgroundColor: 'var(--flat-ok-bg)',
    },
    ':active': {
      transform: 'none',
    },
  },
  tileOffline: {
    opacity: 0.5,
    cursor: 'not-allowed',
    ':hover': {
      backgroundColor: 'var(--flat-fill)',
    },
    ':active': {
      transform: 'none',
    },
  },
  tileTopRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    width: '100%',
  },
  tileIdentity: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4375rem',
    fontSize: '0.875rem',
    fontWeight: 560,
    minWidth: 0,
  },
  tileBottomRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.375rem',
    width: '100%',
    fontSize: '0.75rem',
    color: 'var(--flat-ink-secondary)',
  },
  waitingActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.75rem',
    color: 'var(--flat-ink-secondary)',
  },
  dotSep: {
    color: 'var(--flat-ink-tertiary)',
    userSelect: 'none',
  },
  deviceCodePill: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.75rem',
    fontWeight: 600,
    paddingInline: '0.375rem',
    paddingBlock: '0.125rem',
    borderRadius: '6px',
    backgroundColor: 'var(--flat-fill-strong)',
    color: 'var(--flat-ink)',
  },
  ringSpinner: {
    width: '12px',
    height: '12px',
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/**
 * 12px ring spinner that stops spinning, tightens its circle, and draws a
 * checkmark stroke over `220ms` (`check-draw`) without any toast (§6.3).
 */
export function StatusRingOrCheck({
  phase,
  reducedMotion,
}: {
  phase: 'waiting' | 'success';
  reducedMotion: boolean;
}) {
  if (phase === 'waiting') {
    return (
      <motion.svg
        width={12}
        height={12}
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
        animate={reducedMotion ? undefined : { rotate: 360 }}
        transition={
          reducedMotion
            ? undefined
            : { repeat: Number.POSITIVE_INFINITY, duration: 0.9, ease: 'linear' }
        }
        {...stylex.props(styles.ringSpinner)}
      >
        <circle cx="6" cy="6" r="4.75" stroke="currentColor" strokeOpacity={0.22} strokeWidth="1.5" />
        <path
          d="M6 1.25A4.75 4.75 0 0 1 10.75 6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </motion.svg>
    );
  }

  return (
    <motion.svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      initial={reducedMotion ? { opacity: 0 } : { scale: 1.08, opacity: 0.85 }}
      animate={reducedMotion ? { opacity: 1 } : { scale: 1, opacity: 1 }}
      transition={{ duration: reducedMotion ? 0.1 : 0.16, ease: EASE_OUT }}
      {...stylex.props(styles.ringSpinner)}
    >
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeOpacity={0.32} strokeWidth="1.35" />
      <motion.path
        d="M3.6 6.15L5.25 7.8L8.55 4.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reducedMotion ? { opacity: 0 } : { pathLength: 0 }}
        animate={reducedMotion ? { opacity: 1 } : { pathLength: 1 }}
        transition={{
          duration: reducedMotion ? CHECK_DRAW_S * 0.5 : CHECK_DRAW_S,
          ease: EASE_OUT,
        }}
      />
    </motion.svg>
  );
}

export function BrowserAuthButton({
  variant = 'primary',
  phase,
  label,
  subtitle,
  icon,
  authorizationUrl,
  userCode,
  layoutId,
  autoFocus,
  onStart,
  onCancel,
  onSuccessComplete,
  'data-testid': testId,
}: {
  variant?: 'primary' | 'tile';
  phase: BrowserAuthPhase;
  label: string;
  subtitle?: string;
  icon?: ReactNode;
  authorizationUrl?: string | null;
  userCode?: string | null;
  layoutId?: string;
  autoFocus?: boolean;
  onStart: () => void;
  onCancel: () => void;
  onSuccessComplete?: () => void;
  'data-testid'?: string;
}) {
  const { t } = useTranslation();
  const reducedMotion = useOnboardingReducedMotion();
  const online = useOnlineStatus();
  const [copied, setCopied] = useState(false);
  const completedRef = useRef(false);

  useEffect(() => {
    if (phase !== 'success') {
      completedRef.current = false;
      return undefined;
    }
    if (completedRef.current || !onSuccessComplete) return undefined;
    completedRef.current = true;
    const holdMs = reducedMotion ? Math.round(HOLD_SUCCESS_MS * 0.5) : HOLD_SUCCESS_MS;
    const timer = window.setTimeout(() => {
      onSuccessComplete();
    }, holdMs);
    return () => window.clearTimeout(timer);
  }, [onSuccessComplete, phase, reducedMotion]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopyLink = async () => {
    if (!authorizationUrl) return;
    try {
      await navigator.clipboard.writeText(authorizationUrl);
      setCopied(true);
    } catch {
      // Clipboard write may fail in headless environments.
    }
  };

  if (variant === 'tile') {
    const interactive = phase === 'idle' && online;
    return (
      <motion.div
        layout={!reducedMotion}
        layoutId={reducedMotion ? undefined : layoutId}
        transition={SPRING_CHIP}
        style={{ width: '100%' }}
      >
        {phase === 'waiting' ? (
          <div
            data-testid={testId}
            role="group"
            aria-label={label}
            {...stylex.props(styles.tile, styles.tileWaiting)}
          >
            <div {...stylex.props(styles.tileTopRow)}>
              <span {...stylex.props(styles.tileIdentity)}>
                <StatusRingOrCheck phase="waiting" reducedMotion={reducedMotion} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t('onboarding.auth.continueInBrowser', {
                    defaultValue: 'Continue in browser…',
                  })}
                </span>
              </span>
              {userCode ? <span {...stylex.props(styles.deviceCodePill)}>{userCode}</span> : null}
            </div>
            <div {...stylex.props(styles.waitingActions)}>
              {authorizationUrl ? (
                <>
                  <button
                    type="button"
                    onClick={() => void handleCopyLink()}
                    {...stylex.props(flatSurface.inlineLink)}
                  >
                    {copied
                      ? t('onboarding.auth.linkCopied', { defaultValue: 'Copied' })
                      : t('onboarding.auth.copyLink', { defaultValue: 'Copy link' })}
                  </button>
                  <span {...stylex.props(styles.dotSep)} aria-hidden="true">
                    ·
                  </span>
                </>
              ) : null}
              <button
                type="button"
                onClick={onCancel}
                {...stylex.props(flatSurface.inlineLink)}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid={testId}
            autoFocus={autoFocus}
            disabled={!interactive}
            onClick={() => interactive && onStart()}
            {...stylex.props(
              styles.tile,
              phase === 'success' && styles.tileSuccess,
              phase === 'idle' && !online && styles.tileOffline
            )}
          >
            <span {...stylex.props(styles.tileTopRow)}>
              <span {...stylex.props(styles.tileIdentity)}>
                {phase === 'success' ? (
                  <StatusRingOrCheck phase="success" reducedMotion={reducedMotion} />
                ) : (
                  icon
                )}
                <span>{label}</span>
              </span>
              {phase === 'idle' && online ? (
                <ArrowUpRight size={14} strokeWidth={1.75} style={{ opacity: 0.45 }} aria-hidden="true" />
              ) : null}
            </span>
            <span {...stylex.props(styles.tileBottomRow)}>
              <span>
                {phase === 'idle' && !online
                  ? t('onboarding.auth.waitingForNetwork', { defaultValue: 'Waiting for network' })
                  : phase === 'success'
                    ? t('onboarding.auth.connected', { defaultValue: 'Connected' })
                    : subtitle || '\u00A0'}
              </span>
            </span>
          </button>
        )}
      </motion.div>
    );
  }

  const primaryDisabled = phase !== 'idle' || !online;
  return (
    <div {...stylex.props(styles.primaryWrap)}>
      <motion.button
        type="button"
        data-testid={testId}
        autoFocus={autoFocus}
        layout={!reducedMotion}
        layoutId={reducedMotion ? undefined : layoutId}
        transition={SPRING_CHIP}
        disabled={primaryDisabled}
        onClick={() => {
          if (!primaryDisabled) onStart();
        }}
        {...stylex.props(
          styles.primaryBtn,
          phase === 'idle' && !online && styles.primaryBtnOffline,
          phase === 'waiting' && styles.primaryBtnWaiting,
          phase === 'success' && styles.primaryBtnSuccess
        )}
      >
        {phase === 'waiting' ? (
          <>
            <StatusRingOrCheck phase="waiting" reducedMotion={reducedMotion} />
            <span>
              {t('onboarding.auth.continueInBrowser', {
                defaultValue: 'Continue in browser…',
              })}
            </span>
          </>
        ) : phase === 'success' ? (
          <>
            <StatusRingOrCheck phase="success" reducedMotion={reducedMotion} />
            <span>{t('onboarding.auth.connected', { defaultValue: 'Connected' })}</span>
          </>
        ) : !online ? (
          <span>
            {t('onboarding.auth.waitingForNetwork', { defaultValue: 'Waiting for network' })}
          </span>
        ) : (
          <>
            {icon}
            <span>{label}</span>
            <ArrowUpRight size={15} strokeWidth={1.85} aria-hidden="true" />
          </>
        )}
      </motion.button>

      <AnimatePresence initial={false}>
        {phase === 'waiting' ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.08 : 0.14 }}
            {...stylex.props(styles.waitingActions)}
          >
            {authorizationUrl ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleCopyLink()}
                  {...stylex.props(flatSurface.inlineLink)}
                >
                  {copied
                    ? t('onboarding.auth.linkCopied', { defaultValue: 'Copied' })
                    : t('onboarding.auth.copyLink', { defaultValue: 'Copy link' })}
                </button>
                <span {...stylex.props(styles.dotSep)} aria-hidden="true">
                  ·
                </span>
              </>
            ) : null}
            <button
              type="button"
              onClick={onCancel}
              {...stylex.props(flatSurface.inlineLink)}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
