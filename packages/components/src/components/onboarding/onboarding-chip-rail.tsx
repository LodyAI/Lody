import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type {
  DesktopOnboardingAccountChip,
  DesktopOnboardingModelChip,
  DesktopOnboardingResumePhase,
} from '@/atoms/onboarding';
import { WINDOW_DRAG_EXEMPT_CLASS } from '@/ui/window-drag-region';
import { EASE_IN, SPRING_CHIP, useOnboardingReducedMotion } from './motion-tokens';
import { formatConnectionSourceBadge } from './shared/provider-brand-icon';

export const ACCOUNT_CHIP_LAYOUT_ID = 'onboarding-chip-account';
export const MODEL_CHIP_LAYOUT_ID = 'onboarding-chip-model';

const styles = stylex.create({
  rail: {
    position: 'fixed',
    top: '2.75rem',
    insetInlineStart: 'clamp(1.5rem, 4vw, 3.25rem)',
    zIndex: 35,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    pointerEvents: 'none',
  },
  chip: {
    pointerEvents: 'auto',
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '999px',
    backgroundColor: 'var(--flat-fill)',
    color: 'var(--flat-ink)',
    paddingBlock: '0.375rem',
    paddingInline: '0.75rem',
    fontSize: '0.78125rem',
    fontWeight: 500,
    lineHeight: 1.25,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4375rem',
    cursor: 'pointer',
    userSelect: 'none',
    transitionProperty: 'background-color, transform',
    transitionDuration: '140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  chipActiveStep: {
    backgroundColor: 'var(--flat-fill-strong)',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    backgroundColor: '#16A34A',
    flexShrink: 0,
  },
  secondaryPart: {
    color: 'var(--flat-ink-secondary)',
    fontWeight: 450,
  },
});

/**
 * Persistent top-left chip rail (§5.0):
 * each completed decision flies here via shared-layout (`SPRING_CHIP`) and stays
 * clickable so the user can revisit `account` or `model` without progress-bar noise.
 */
export function OnboardingChipRail({
  currentPhase,
  accountChip,
  modelChip,
  exitingToProduct = false,
  onSelectPhase,
}: {
  currentPhase: DesktopOnboardingResumePhase;
  accountChip: DesktopOnboardingAccountChip | null;
  modelChip: DesktopOnboardingModelChip | null;
  exitingToProduct?: boolean;
  onSelectPhase: (phase: 'account' | 'model') => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = useOnboardingReducedMotion();

  const showAccount = Boolean(accountChip) && currentPhase !== 'arrive';
  const showModel = Boolean(modelChip) && currentPhase !== 'arrive';

  if (!showAccount && !showModel) {
    return null;
  }

  return (
    <motion.nav
      aria-label={t('onboarding.chipRail.ariaLabel', { defaultValue: 'Completed setup choices' })}
      animate={exitingToProduct ? { opacity: 0 } : { opacity: 1 }}
      transition={{ duration: reducedMotion ? 0.08 : 0.16, ease: EASE_IN }}
      className={WINDOW_DRAG_EXEMPT_CLASS}
      {...stylex.props(styles.rail)}
      data-testid="onboarding-chip-rail"
    >
      <AnimatePresence initial={false}>
        {showAccount && accountChip ? (
          <motion.button
            key="chip-account"
            type="button"
            layout={!reducedMotion}
            layoutId={reducedMotion ? undefined : ACCOUNT_CHIP_LAYOUT_ID}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={SPRING_CHIP}
            data-testid="onboarding-chip-account"
            onClick={() => onSelectPhase('account')}
            {...stylex.props(
              styles.chip,
              currentPhase === 'account' && styles.chipActiveStep
            )}
          >
            <span {...stylex.props(styles.dot)} aria-hidden="true" />
            <span>{accountChip.userLabel}</span>
            <span {...stylex.props(styles.secondaryPart)}>· {accountChip.workspaceName}</span>
          </motion.button>
        ) : null}

        {showModel && modelChip ? (
          <motion.button
            key="chip-model"
            type="button"
            layout={!reducedMotion}
            layoutId={reducedMotion ? undefined : MODEL_CHIP_LAYOUT_ID}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={SPRING_CHIP}
            data-testid="onboarding-chip-model"
            onClick={() => onSelectPhase('model')}
            {...stylex.props(
              styles.chip,
              currentPhase === 'model' && styles.chipActiveStep
            )}
          >
            <span {...stylex.props(styles.dot)} aria-hidden="true" />
            <span>{modelChip.providerName}</span>
            <span {...stylex.props(styles.secondaryPart)}>
              · {formatConnectionSourceBadge(modelChip.source, t)}
            </span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </motion.nav>
  );
}
