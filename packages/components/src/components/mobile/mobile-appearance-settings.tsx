import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import type { SupportedLanguage } from '@lody/shared';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { motion } from 'framer-motion';

import {
  conversationFontSizeAtom,
  CONVERSATION_FONT_SIZE_MAX,
  CONVERSATION_FONT_SIZE_MIN,
  languageAtom,
  normalizeConversationFontSize,
} from '@/atoms';
import {
  MobileInlineMenu,
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';
import { MobileSettingsPickerTrigger } from '@/components/mobile/mobile-settings-picker-trigger';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { Input } from '@lody/ui/input';
import { currentSupportedLanguages, languageCodeToName } from '../../i18n';
import { cn } from '@/lib/utils';
import { withOneSignal } from '@/lib/onesignal';
import { useTheme, type Theme } from '../../theme-provider';

export function MobileAppearanceSettings() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useAtom(languageAtom);
  const [conversationFontSize, setConversationFontSize] = useAtom(conversationFontSizeAtom);
  const selectedThemeLabel =
    theme === 'light'
      ? t('settings.theme.light')
      : theme === 'dark'
        ? t('settings.theme.dark')
        : t('settings.theme.system');

  const handleThemeChange = useCallback(
    (value: Theme) => {
      setTheme(value);
    },
    [setTheme]
  );

  const languageOptions: MobileInlinePickerOption<SupportedLanguage>[] =
    currentSupportedLanguages.map((lang) => ({
      value: lang as SupportedLanguage,
      label: languageCodeToName[lang],
      searchText: languageCodeToName[lang],
    }));
  const selectedLanguageLabel = languageCodeToName[language] ?? language;
  const handleLanguageChange = useCallback(
    (next: SupportedLanguage) => {
      setLanguage(next);
      void i18n.changeLanguage(next);
      if (typeof window === 'undefined' || window.__LODY_ELECTRON__ === true) {
        return;
      }
      void withOneSignal((oneSignal) => {
        void oneSignal.User.setLanguage(next === 'en' ? 'en' : 'zh');
      }).catch((error: unknown) => {
        console.error('Failed to sync OneSignal language', error);
      });
    },
    [i18n, setLanguage]
  );

  return (
    <MobileInlinePickerCoordinator>
      <MobileSettingsSection>
        <MobileInlinePickerRowSlot>
          <MobileSettingsRow label={t('settings.theme.label')}>
            <ThemeModeMenuTrigger
              value={theme}
              onChange={handleThemeChange}
              selectedLabel={selectedThemeLabel}
              selectedIcon={themeIconFor(theme)}
            />
          </MobileSettingsRow>
        </MobileInlinePickerRowSlot>
        <MobileInlinePickerRowSlot>
          <MobileSettingsRow label={t('settings.language.label')} hasDivider>
            <MobileSettingsPickerTrigger
              id="settings-language"
              ariaLabel={String(t('settings.language.label'))}
              value={language}
              options={languageOptions}
              onChange={handleLanguageChange}
              triggerLabel={selectedLanguageLabel}
            />
          </MobileSettingsRow>
        </MobileInlinePickerRowSlot>
      </MobileSettingsSection>

      <MobileSettingsSection>
        <MobileSettingsRow
          label={t('settings.conversationFontSize.label', 'Conversation font size')}
          helper={t(
            'settings.conversationFontSize.helper',
            'Adjusts message body text in conversations.'
          )}
        >
          <Input
            type="number"
            min={CONVERSATION_FONT_SIZE_MIN}
            max={CONVERSATION_FONT_SIZE_MAX}
            step={1}
            value={conversationFontSize}
            aria-label={t('settings.conversationFontSize.label', 'Conversation font size')}
            className="h-8 w-20 text-center"
            onChange={(event) => {
              if (Number.isFinite(event.target.valueAsNumber)) {
                setConversationFontSize(normalizeConversationFontSize(event.target.valueAsNumber));
              }
            }}
          />
        </MobileSettingsRow>
      </MobileSettingsSection>
    </MobileInlinePickerCoordinator>
  );
}

function themeIconFor(value: Theme) {
  if (value === 'light') {
    return <Sun className="h-4 w-4" aria-hidden="true" />;
  }
  if (value === 'dark') {
    return <Moon className="h-4 w-4" aria-hidden="true" />;
  }
  return <Monitor className="h-4 w-4" aria-hidden="true" />;
}

function ThemeModeMenuTrigger({
  value,
  onChange,
  selectedLabel,
  selectedIcon,
}: {
  value: Theme;
  onChange: (next: Theme) => void;
  selectedLabel: ReactNode;
  selectedIcon?: ReactNode;
}) {
  const { t } = useTranslation();
  const modeTiles: Array<{
    value: Theme;
    label: string;
    icon: ReactNode;
  }> = [
    {
      value: 'light',
      label: String(t('settings.theme.light')),
      icon: <Sun className="h-4 w-4" aria-hidden="true" />,
    },
    {
      value: 'dark',
      label: String(t('settings.theme.dark')),
      icon: <Moon className="h-4 w-4" aria-hidden="true" />,
    },
    {
      value: 'system',
      label: String(t('settings.theme.system')),
      icon: <Monitor className="h-4 w-4" aria-hidden="true" />,
    },
  ];

  return (
    <div className="inline-block max-w-[60vw]">
      <MobileInlineMenu
        id="settings-theme"
        ariaLabel={String(t('settings.theme.label'))}
        triggerClassName={cn(
          'group/picker-trigger inline-flex w-auto items-center gap-2 rounded-md px-3 py-1.5',
          'text-sm font-medium text-left transition-all',
          'bg-input/40 text-foreground/85',
          'hover:bg-muted/60 hover:text-foreground',
          'active:scale-[0.985]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
        )}
        triggerContent={
          <>
            {selectedIcon ? <span className="shrink-0">{selectedIcon}</span> : null}
            <span className="min-w-0 truncate text-right">{selectedLabel}</span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 opacity-60"
              strokeWidth={2}
              aria-hidden="true"
            />
          </>
        }
        expansionPanelClassName="p-0"
      >
        {() => (
          <div role="radiogroup" className="grid grid-cols-3 gap-2 p-2">
            {modeTiles.map((tile) => {
              const selected = tile.value === value;
              return (
                <motion.button
                  key={tile.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => onChange(tile.value)}
                  className={cn(
                    'relative flex flex-col items-center justify-center gap-1 rounded-xl border px-3 py-3',
                    'text-xs font-medium transition-all',
                    'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'border-primary/60 bg-primary/[0.06] text-foreground shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]'
                      : 'border-border/60 bg-card/40 text-muted-foreground hover:bg-card/70 hover:text-foreground'
                  )}
                >
                  <span
                    className={cn(
                      'transition-colors',
                      selected ? 'text-primary' : 'text-muted-foreground'
                    )}
                  >
                    {tile.icon}
                  </span>
                  <span>{tile.label}</span>
                  {selected ? (
                    <span className="absolute right-1.5 top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden="true" />
                    </span>
                  ) : null}
                </motion.button>
              );
            })}
          </div>
        )}
      </MobileInlineMenu>
    </div>
  );
}
