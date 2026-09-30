import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAtom } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import type { SupportedLanguage } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { languageAtom } from '@/atoms/settings';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { OnboardingShell, OnboardingNextButton } from '../onboarding-shell';
import { onboardingSurface as surface } from './surface';

const styles = stylex.create({
  options: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 640px)': 'repeat(2, 1fr)' },
    gap: space[3],
  },
  option: { position: 'relative', paddingInline: space[6], paddingBlock: space[6] },
  check: { position: 'absolute', insetBlockStart: space[3], insetInlineEnd: space[3] },
  glyph: {
    width: '56px',
    height: '56px',
    fontSize: '24px',
    fontWeight: 500,
    color: colors.label,
  },
  labels: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  nativeLabel: {
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 500,
    color: colors.label,
  },
});

interface LanguageOption {
  value: SupportedLanguage;
  // Display label is intentionally rendered in the option's own language so the
  // user can recognise it without relying on the current UI locale.
  nativeLabel: string;
  caption: string;
  glyph: string;
}

const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: 'en', nativeLabel: 'English', caption: 'English', glyph: 'A' },
  { value: 'zh_CN', nativeLabel: '简体中文', caption: 'Chinese (Simplified)', glyph: '中' },
];

export interface LanguageScreenViewProps {
  /** Currently selected language. */
  value: SupportedLanguage;
  onChange: (next: SupportedLanguage) => void;
  onNext: () => void;
}

export function LanguageScreenView({ value, onChange, onNext }: LanguageScreenViewProps) {
  const { t } = useTranslation();

  return (
    <OnboardingShell
      stepKey="language"
      title={t('onboarding.language.title', 'Choose your language')}
      description={t(
        'onboarding.language.description',
        'You can switch this anytime from settings.'
      )}
      primaryAction={<OnboardingNextButton onClick={onNext} />}
    >
      <div
        role="radiogroup"
        aria-label={t('onboarding.language.title', 'Choose your language')}
        {...stylex.props(styles.options)}
      >
        {LANGUAGE_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              {...stylex.props(
                surface.tile,
                surface.tileHover,
                surface.tileColumn,
                styles.option,
                selected && surface.tileSelected
              )}
            >
              {selected ? (
                <motion.span
                  layoutId="onboarding-language-check"
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  {...stylex.props(surface.selectedMark, styles.check)}
                >
                  <Check {...stylex.props(surface.icon12)} />
                </motion.span>
              ) : null}
              <span {...stylex.props(surface.glyphBox, styles.glyph)}>{option.glyph}</span>
              <span {...stylex.props(styles.labels)}>
                <span {...stylex.props(styles.nativeLabel)}>{option.nativeLabel}</span>
                <span {...stylex.props(surface.detail)}>{option.caption}</span>
              </span>
            </button>
          );
        })}
      </div>
    </OnboardingShell>
  );
}

interface LanguageScreenProps {
  onNext: () => void;
}

export function LanguageScreen({ onNext }: LanguageScreenProps) {
  const { i18n } = useTranslation();
  const [language, setLanguage] = useAtom(languageAtom);

  const handleSelect = (next: SupportedLanguage) => {
    setLanguage(next);
    void i18n.changeLanguage(next);
    void getIpcServices()?.app.setLanguage(next);
  };

  return <LanguageScreenView value={language} onChange={handleSelect} onNext={onNext} />;
}
