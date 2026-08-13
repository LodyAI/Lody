import { useTranslation } from 'react-i18next';
import { Check, Moon, Sun } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { useResolvedTheme, useTheme } from '../../../theme-provider';
import { OnboardingShell, OnboardingBackButton, OnboardingNextButton } from '../onboarding-shell';

type Mode = 'light' | 'dark';

interface ModeOption {
  value: Mode;
  labelKey: string;
  labelDefault: string;
  Icon: (props: { className?: string }) => React.JSX.Element;
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
];

export interface ThemeScreenViewProps {
  /** Selected mode (light/dark). */
  mode: Mode;
  onModeChange: (next: Mode) => void;
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
      description={t('onboarding.theme.description', 'Choose light or dark.')}
      secondaryAction={<OnboardingBackButton onClick={onBack} />}
      primaryAction={<OnboardingNextButton onClick={onNext} />}
    >
      <div className="space-y-2">
        <div className="text-xs font-medium tracking-wider text-muted-foreground/80">
          {t('onboarding.theme.modeHeading', 'Mode')}
        </div>
        <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
          {MODE_OPTIONS.map((option) => {
            const selected = mode === option.value;
            return (
              <motion.button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                whileTap={{ scale: 0.98 }}
                onClick={() => onModeChange(option.value)}
                className={cn(
                  'group relative flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-all',
                  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'border-primary/60 bg-primary/[0.06] text-foreground shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]'
                    : 'border-border/60 bg-card/40 text-muted-foreground hover:bg-card/70 hover:text-foreground'
                )}
              >
                <option.Icon
                  className={cn(
                    'h-4 w-4 transition-colors',
                    selected ? 'text-primary' : 'text-muted-foreground'
                  )}
                />
                <span>{t(option.labelKey, option.labelDefault)}</span>
                {selected ? (
                  <span className="absolute right-2 top-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                ) : null}
              </motion.button>
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
 * Container that wires the global light/dark mode. The app ships a single
 * light theme (Lody Light) and a single dark theme (Vesper), so the
 * only choice here is the base mode. Click commits — no hover preview, since
 * that proved jarring during onboarding.
 */
export function ThemeScreen({ onBack, onNext }: ThemeScreenProps) {
  const { theme, setTheme } = useTheme();
  const resolvedTheme = useResolvedTheme();

  // The provider may still hold 'system' (its first-run default); show the
  // effective mode so a tile is always selected.
  const mode: Mode = theme === 'system' ? resolvedTheme : theme;

  return (
    <ThemeScreenView
      mode={mode}
      onModeChange={(next) => setTheme(next)}
      onBack={onBack}
      onNext={onNext}
    />
  );
}
