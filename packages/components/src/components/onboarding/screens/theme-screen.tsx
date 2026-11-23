import { useTranslation } from 'react-i18next';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { useTheme, type Theme } from '../../../theme-provider';
import { OnboardingShell, OnboardingBackButton, OnboardingNextButton } from '../onboarding-shell';
import { onboardingSurface as surface } from './surface';

const styles = stylex.create({
  options: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr', '@media (min-width: 640px)': 'repeat(3, 1fr)' },
    gap: space[2],
  },
  option: {
    position: 'relative',
    justifyContent: 'center',
    gap: space[2],
    paddingInline: space[4],
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
  },
  check: {
    position: 'absolute',
    insetBlockStart: space[2],
    insetInlineEnd: space[2],
    width: '14px',
    height: '14px',
  },
  checkGlyph: { width: '10px', height: '10px' },
});

interface ModeOption {
  value: Theme;
  labelKey: string;
  labelDefault: string;
  Icon: (props: { className?: string; style?: React.CSSProperties }) => React.JSX.Element;
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: 'light',
    labelKey: 'onboarding.theme.light',
    labelDefault: 'Light',
    Icon: (props) => <Sun {...props} strokeWidth={1.6} />,
  },
  {
    value: 'dark',
    labelKey: 'onboarding.theme.dark',
    labelDefault: 'Dark',
    Icon: (props) => <Moon {...props} strokeWidth={1.6} />,
  },
  {
    value: 'system',
    labelKey: 'onboarding.theme.system',
    labelDefault: 'System',
    Icon: (props) => <Monitor {...props} strokeWidth={1.6} />,
  },
];

export interface ThemeScreenViewProps {
  /** Selected mode (light/dark/system). */
  mode: Theme;
  onModeChange: (next: Theme) => void;
  onBack: () => void;
  onNext: () => void;
}

// Click commits; hover does NOT preview (per design feedback).
export function ThemeScreenView({ mode, onModeChange, onBack, onNext }: ThemeScreenViewProps) {
  const { t } = useTranslation();

  return (
    <OnboardingShell
      stepKey="theme"
      size="wide"
      title={t('onboarding.theme.title', 'Pick a look')}
      description={t('onboarding.theme.description', 'Choose light, dark, or follow your system.')}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={<OnboardingNextButton onClick={onNext} />}
    >
      <div {...stylex.props(surface.stackTight)}>
        <div {...stylex.props(surface.groupLabel)}>{t('onboarding.theme.modeHeading', 'Mode')}</div>
        <div role="radiogroup" {...stylex.props(styles.options)}>
          {MODE_OPTIONS.map((option) => {
            const selected = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onModeChange(option.value)}
                {...stylex.props(
                  surface.tile,
                  surface.tileHover,
                  styles.option,
                  selected && surface.tileSelected
                )}
              >
                <option.Icon
                  {...stylex.props(
                    surface.icon16,
                    selected ? surface.iconAccent : surface.iconMuted
                  )}
                />
                <span>{t(option.labelKey, option.labelDefault)}</span>
                {selected ? (
                  <span {...stylex.props(surface.selectedMark, styles.check)}>
                    <Check {...stylex.props(styles.checkGlyph)} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </OnboardingShell>
  );
}

interface ThemeScreenProps {
  onBack: () => void;
  onNext: () => void;
}

/**
 * Container that wires the global appearance mode. The app ships a single
 * light palette (Lody Light) and a single dark palette (Vesper); the choice
 * here is light, dark, or follow the OS. Click commits — no hover preview,
 * since that proved jarring during onboarding.
 */
export function ThemeScreen({ onBack, onNext }: ThemeScreenProps) {
  const { theme, setTheme } = useTheme();

  return (
    <ThemeScreenView
      mode={theme}
      onModeChange={(next) => setTheme(next)}
      onBack={onBack}
      onNext={onNext}
    />
  );
}
