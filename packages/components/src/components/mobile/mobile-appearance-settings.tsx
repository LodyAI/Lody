import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { usePostHog } from '@posthog/react';
import * as stylex from '@stylexjs/stylex';
import type { SupportedLanguage } from '@lody/shared';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { motion } from 'framer-motion';

import {
  conversationFontSizeAtom,
  extendedCodeLanguagesEnabledAtom,
  fontLigaturesEnabledAtom,
  inlineMathEnabledAtom,
  languageAtom,
} from '@/atoms';
import {
  MobileInlineMenu,
  MobileInlinePickerCoordinator,
  MobileInlinePickerRowSlot,
  type MobileInlinePickerOption,
} from '@/components/mobile/mobile-inline-picker';
import { MobileSettingsPickerTrigger } from '@/components/mobile/mobile-settings-picker-trigger';
import { MobileSettingsRow, MobileSettingsSection } from '@/components/mobile/mobile-settings-row';
import { MobileAppIconSettings } from '@/components/mobile/mobile-app-icon-settings';
import { buildConversationFontSizeChoices } from '@/components/settings/conversation-font-size-options';
import { currentSupportedLanguages, languageCodeToName } from '../../i18n';
import { Switch } from '@lody/ui/switch';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { withOneSignal } from '@/lib/onesignal';
import { useTheme, type Theme } from '../../theme-provider';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  /** The trigger's box: it hugs its label and never takes the whole row. */
  triggerBox: { display: 'inline-block', maxWidth: '60vw' },
  /**
   * The trigger: a quiet chip that opens the theme menu. Its focus ring was a
   * Tailwind `focus-visible:ring-*`, which this app paints as nothing (the
   * global focus rule zeroes Tailwind's ring shadow), so it keeps no ring
   * rather than gaining one.
   */
  trigger: {
    display: 'inline-flex',
    width: 'auto',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1.5],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    textAlign: 'left',
    transitionProperty: 'all',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    backgroundColor: {
      default: 'hsl(var(--input) / 0.4)',
      ':hover': 'hsl(var(--muted) / 0.6)',
    },
    color: {
      default: 'hsl(var(--foreground) / 0.85)',
      ':hover': themeColors.foreground,
    },
    scale: { default: null, ':active': '0.985' },
  },
  /** The trigger's icon slot. */
  iconSlot: { flexShrink: 0 },
  /** The trigger's label: it truncates and keeps the row on one line. */
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'right',
  },
  /** The chevron that says the trigger opens a list. */
  chevron: {
    height: themeSpace[3.5],
    width: themeSpace[3.5],
    flexShrink: 0,
    opacity: 0.6,
  },
  /** The three modes, side by side. */
  modes: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: themeSpace[2],
    padding: themeSpace[2],
  },
  /**
   * One mode. The focus ring was a Tailwind `focus-visible:ring-*`, which this
   * app paints as nothing, so the tile keeps no ring.
   */
  mode: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[3],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.medium,
    transitionProperty: 'all',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The mode in use: the accent's edge, and a halo in the same accent. */
  modeSelected: {
    borderColor: 'hsl(var(--primary) / 0.6)',
    backgroundColor: 'hsl(var(--primary) / 0.06)',
    color: themeColors.foreground,
    boxShadow: '0 0 0 3px hsl(var(--primary)/0.08)',
  },
  /** The other modes: the ordinary edge, quietened until the pointer arrives. */
  modeIdle: {
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: {
      default: 'hsl(var(--card) / 0.4)',
      ':hover': 'hsl(var(--card) / 0.7)',
    },
    color: {
      default: themeColors.mutedForeground,
      ':hover': themeColors.foreground,
    },
  },
  /** The mode's mark. */
  modeIcon: {
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  modeIconSelected: { color: themeColors.primary },
  modeIconIdle: { color: themeColors.mutedForeground },
  /** The mark that says this mode is in use. */
  modeMark: {
    position: 'absolute',
    right: themeSpace[1.5],
    top: themeSpace[1.5],
    display: 'flex',
    height: themeSpace[3.5],
    width: themeSpace[3.5],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
  },
  modeMarkGlyph: { height: themeSpace[2.5], width: themeSpace[2.5] },
  /** A mode's mark in the list. */
  icon: { height: themeSpace[4], width: themeSpace[4] },
});

export function MobileAppearanceSettings() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [language, setLanguage] = useAtom(languageAtom);
  const [conversationFontSize, setConversationFontSize] = useAtom(conversationFontSizeAtom);
  const [fontLigaturesEnabled, setFontLigaturesEnabled] = useAtom(fontLigaturesEnabledAtom);
  const [inlineMathEnabled, setInlineMathEnabled] = useAtom(inlineMathEnabledAtom);
  const [extendedCodeLanguagesEnabled, setExtendedCodeLanguagesEnabled] = useAtom(
    extendedCodeLanguagesEnabledAtom
  );
  const postHog = usePostHog();
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

  const fontSizeOptions: MobileInlinePickerOption<string>[] =
    buildConversationFontSizeChoices().map(({ value, labelKey }) => {
      const label = String(t(labelKey));
      return { value, label, searchText: label };
    });
  const selectedFontSizeLabel =
    fontSizeOptions.find((option) => option.value === String(conversationFontSize))?.label ??
    String(conversationFontSize);
  const handleFontSizeChange = useCallback(
    (next: string) => {
      const to = Number(next);
      if (to !== conversationFontSize) {
        capturePostHogEvent(postHog, 'settings/font_size_changed', {
          from: conversationFontSize,
          to,
        });
      }
      setConversationFontSize(to);
    },
    [conversationFontSize, postHog, setConversationFontSize]
  );
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
        <MobileInlinePickerRowSlot>
          <MobileSettingsRow label={t('settings.conversationFontSize.label', 'Font size')}>
            <MobileSettingsPickerTrigger
              id="settings-conversation-font-size"
              ariaLabel={String(t('settings.conversationFontSize.label', 'Font size'))}
              value={String(conversationFontSize)}
              options={fontSizeOptions}
              onChange={handleFontSizeChange}
              triggerLabel={selectedFontSizeLabel}
            />
          </MobileSettingsRow>
        </MobileInlinePickerRowSlot>
        <MobileSettingsRow
          label={t('settings.inlineMath.label', 'Render inline math')}
          helper={t('settings.inlineMath.helper', 'Typeset $...$ and \\(...\\) in Markdown.')}
          hasDivider
        >
          <Switch
            checked={inlineMathEnabled}
            onCheckedChange={setInlineMathEnabled}
            aria-label={t('settings.inlineMath.label', 'Render inline math')}
          />
        </MobileSettingsRow>
        <MobileSettingsRow
          label={t('settings.extendedCodeLanguages.label', 'Extended code languages')}
          helper={t(
            'settings.extendedCodeLanguages.helper',
            'Adds more syntax grammars, including Lean and Rocq. Each grammar loads when first used and can slow that render.'
          )}
          hasDivider
        >
          <Switch
            checked={extendedCodeLanguagesEnabled}
            onCheckedChange={setExtendedCodeLanguagesEnabled}
            aria-label={t('settings.extendedCodeLanguages.label', 'Extended code languages')}
          />
        </MobileSettingsRow>
      </MobileSettingsSection>

      <MobileSettingsSection>
        <MobileSettingsRow
          label={t('settings.fontLigatures.label', 'Font ligatures')}
          helper={t(
            'settings.fontLigatures.helper',
            'Applies to conversation, code, and tool output.'
          )}
        >
          <Switch
            checked={fontLigaturesEnabled}
            onCheckedChange={setFontLigaturesEnabled}
            aria-label={t('settings.fontLigatures.label', 'Font ligatures')}
          />
        </MobileSettingsRow>
      </MobileSettingsSection>

      <MobileAppIconSettings />
    </MobileInlinePickerCoordinator>
  );
}

function themeIconFor(value: Theme) {
  if (value === 'light') {
    return <Sun {...stylex.props(styles.icon)} aria-hidden="true" />;
  }
  if (value === 'dark') {
    return <Moon {...stylex.props(styles.icon)} aria-hidden="true" />;
  }
  return <Monitor {...stylex.props(styles.icon)} aria-hidden="true" />;
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
      icon: <Sun {...stylex.props(styles.icon)} aria-hidden="true" />,
    },
    {
      value: 'dark',
      label: String(t('settings.theme.dark')),
      icon: <Moon {...stylex.props(styles.icon)} aria-hidden="true" />,
    },
    {
      value: 'system',
      label: String(t('settings.theme.system')),
      icon: <Monitor {...stylex.props(styles.icon)} aria-hidden="true" />,
    },
  ];

  return (
    <div {...stylex.props(styles.triggerBox)}>
      <MobileInlineMenu
        id="settings-theme"
        ariaLabel={String(t('settings.theme.label'))}
        triggerClassName={stylex.props(styles.trigger).className}
        triggerContent={
          <>
            {selectedIcon ? <span {...stylex.props(styles.iconSlot)}>{selectedIcon}</span> : null}
            <span {...stylex.props(styles.label)}>{selectedLabel}</span>
            <ChevronDown {...stylex.props(styles.chevron)} strokeWidth={2} aria-hidden="true" />
          </>
        }
        expansionPanelClassName="p-0"
      >
        {() => (
          <div role="radiogroup" {...stylex.props(styles.modes)}>
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
                  {...stylex.props(styles.mode, selected ? styles.modeSelected : styles.modeIdle)}
                >
                  <span
                    {...stylex.props(
                      styles.modeIcon,
                      selected ? styles.modeIconSelected : styles.modeIconIdle
                    )}
                  >
                    {tile.icon}
                  </span>
                  <span>{tile.label}</span>
                  {selected ? (
                    <span {...stylex.props(styles.modeMark)}>
                      <Check
                        {...stylex.props(styles.modeMarkGlyph)}
                        strokeWidth={3}
                        aria-hidden="true"
                      />
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
