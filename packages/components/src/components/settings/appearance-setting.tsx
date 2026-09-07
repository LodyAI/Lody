import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { Monitor, Moon, SquareTerminal, Sun } from 'lucide-react';

import {
  conversationFontSizeAtom,
  CONVERSATION_FONT_SIZE_MAX,
  CONVERSATION_FONT_SIZE_MIN,
  interfaceFontFamilyAtom,
  normalizeConversationFontSize,
  normalizeTerminalFontSize,
  terminalFontFamilyAtom,
  terminalFontSizeAtom,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type ConversationFontSize,
} from '@/atoms';
import { MobileAppearanceSettings } from '@/components/mobile/mobile-appearance-settings';
import { OptionSelector, type OptionSelectorOption } from '@/components/shared/option-selector';
import { buildTerminalFontPreviewFamily } from '@/components/terminal/terminal-theme';
import { useIsMobile } from '@/hooks/use-mobile';
import { listSystemFontFamilies } from '@/lib/local-fonts';
import { Input } from '@/ui/input';
import { LanguageSelector } from '../../i18n';
import { useTheme, type Theme } from '../../theme-provider';
import { settingContainerClass } from '.';
import { CompactRow, CompactSection } from './compact-layout';
import { PreviewSelect, type PreviewSelectOption } from './preview-select';

export type SystemFontLoadState = 'idle' | 'loading' | 'loaded' | 'error';

export interface AppearanceSettingsViewProps {
  theme: Theme;
  onThemePreview: (value: Theme) => void;
  onThemeCommit: (value: Theme) => void;
  onThemeCancel: () => void;
  conversationFontSize: ConversationFontSize;
  onConversationFontSizeChange: (value: ConversationFontSize) => void;
  isElectron: boolean;
  interfaceFontFamily: string;
  onInterfaceFontFamilyChange: (value: string) => void;
  terminalFontFamily: string;
  onTerminalFontFamilyChange: (value: string) => void;
  systemFontFamilies: string[];
  systemFontLoadState: SystemFontLoadState;
  onSystemFontMenuOpen: () => void;
  terminalFontSize: number;
  onTerminalFontSizeChange: (value: number) => void;
}

function buildSystemFontOptions(
  families: string[],
  selectedFamily: string,
  defaultLabel: string,
  defaultKey: string
): OptionSelectorOption<string>[] {
  const availableFamilies = families.some(
    (family) => family.toLowerCase() === selectedFamily.toLowerCase()
  )
    ? families
    : selectedFamily
      ? [selectedFamily, ...families]
      : families;

  return [
    { key: defaultKey, value: '', label: defaultLabel },
    ...availableFamilies.map((family) => ({ value: family, label: family })),
  ];
}

export function AppearanceSettingsView({
  theme,
  onThemePreview,
  onThemeCommit,
  onThemeCancel,
  conversationFontSize,
  onConversationFontSizeChange,
  isElectron,
  interfaceFontFamily,
  onInterfaceFontFamilyChange,
  terminalFontFamily,
  onTerminalFontFamilyChange,
  systemFontFamilies,
  systemFontLoadState,
  onSystemFontMenuOpen,
  terminalFontSize,
  onTerminalFontSizeChange,
}: AppearanceSettingsViewProps) {
  const { t } = useTranslation();

  const themeOptions: PreviewSelectOption<Theme>[] = [
    {
      value: 'light',
      label: (
        <div className="flex items-center gap-2">
          <Sun className="h-4 w-4" />
          <span>{t('settings.theme.light')}</span>
        </div>
      ),
    },
    {
      value: 'dark',
      label: (
        <div className="flex items-center gap-2">
          <Moon className="h-4 w-4" />
          <span>{t('settings.theme.dark')}</span>
        </div>
      ),
    },
    {
      value: 'system',
      label: (
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4" />
          <span>{t('settings.theme.system')}</span>
        </div>
      ),
    },
  ];

  const defaultFontLabel = t('settings.terminal.fontFamily.placeholder', 'Default');
  const interfaceFontOptions = useMemo(
    () =>
      buildSystemFontOptions(
        systemFontFamilies,
        interfaceFontFamily,
        defaultFontLabel,
        'interface-font-default'
      ),
    [defaultFontLabel, interfaceFontFamily, systemFontFamilies]
  );
  const terminalFontOptions = useMemo(
    () =>
      buildSystemFontOptions(
        systemFontFamilies,
        terminalFontFamily,
        defaultFontLabel,
        'terminal-font-default'
      ),
    [defaultFontLabel, systemFontFamilies, terminalFontFamily]
  );

  const fontLoadStatus =
    systemFontLoadState === 'loading' ? (
      <span>{t('settings.terminal.fontFamily.loading', 'Loading system fonts...')}</span>
    ) : systemFontLoadState === 'error' ? (
      <span className="text-destructive">
        {t(
          'settings.terminal.fontFamily.unavailable',
          'System fonts could not be loaded. Reopen the menu to try again.'
        )}
      </span>
    ) : null;

  return (
    <div className={settingContainerClass}>
      <CompactSection>
        <CompactRow label={t('settings.theme.label')}>
          <PreviewSelect
            value={theme}
            options={themeOptions}
            onPreview={onThemePreview}
            onCommit={onThemeCommit}
            onCancel={onThemeCancel}
            triggerClassName="w-full sm:w-[220px]"
          />
        </CompactRow>
        <CompactRow label={t('settings.language.label')}>
          <LanguageSelector triggerClassName="w-full sm:w-[220px]" />
        </CompactRow>
      </CompactSection>

      <CompactSection>
        {isElectron ? (
          <CompactRow
            label={t('settings.interfaceFontFamily.label', 'Interface font')}
            helper={
              <span className="flex flex-col gap-0.5">
                <span>
                  {t(
                    'settings.interfaceFontFamily.helper',
                    'Choose an installed font for the interface and conversation content.'
                  )}
                </span>
                {fontLoadStatus}
              </span>
            }
          >
            <OptionSelector
              value={interfaceFontFamily}
              options={interfaceFontOptions}
              onSelect={(option) => onInterfaceFontFamilyChange(option.value)}
              placeholder={defaultFontLabel}
              searchable
              searchPlaceholder={t(
                'settings.terminal.fontFamily.searchPlaceholder',
                'Search system fonts...'
              )}
              emptyText={t('settings.terminal.fontFamily.empty', 'No matching fonts')}
              align="end"
              className="w-full rounded-md border-input-border bg-input sm:w-[220px] hover:bg-input/80"
              contentClassName="w-[320px]"
              onOpenChange={(open) => {
                if (open) onSystemFontMenuOpen();
              }}
              renderTriggerValue={(option) => (
                <span
                  className="truncate font-normal"
                  style={{ fontFamily: 'var(--font-sans-default)' }}
                >
                  {option?.label ?? interfaceFontFamily}
                </span>
              )}
              renderOption={(option) => (
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ fontFamily: 'var(--font-sans-default)' }}
                >
                  {option.label}
                </span>
              )}
            />
          </CompactRow>
        ) : null}
        <CompactRow
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
            className="w-24"
            onChange={(event) => {
              if (Number.isFinite(event.target.valueAsNumber)) {
                onConversationFontSizeChange(
                  normalizeConversationFontSize(event.target.valueAsNumber)
                );
              }
            }}
          />
        </CompactRow>
      </CompactSection>

      {isElectron ? (
        <CompactSection title={t('settings.terminal.title', 'Terminal')}>
          <CompactRow
            label={t('settings.terminal.fontFamily.label', 'Font')}
            helper={fontLoadStatus}
          >
            <OptionSelector
              value={terminalFontFamily}
              options={terminalFontOptions}
              onSelect={(option) => onTerminalFontFamilyChange(option.value)}
              placeholder={defaultFontLabel}
              searchable
              searchPlaceholder={t(
                'settings.terminal.fontFamily.searchPlaceholder',
                'Search system fonts...'
              )}
              emptyText={t('settings.terminal.fontFamily.empty', 'No matching fonts')}
              align="end"
              className="w-full rounded-md border-input-border bg-input sm:w-[220px] hover:bg-input/80"
              contentClassName="w-[320px]"
              onOpenChange={(open) => {
                if (open) onSystemFontMenuOpen();
              }}
              renderTriggerValue={(option) => (
                <span
                  className="truncate font-normal"
                  style={{ fontFamily: 'var(--font-sans-default)' }}
                >
                  {option?.label ?? terminalFontFamily}
                </span>
              )}
              renderOption={(option) => (
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ fontFamily: 'var(--font-sans-default)' }}
                >
                  {option.label}
                </span>
              )}
            />
          </CompactRow>
          <CompactRow label={t('settings.terminal.fontSize.label', 'Font size')}>
            <Input
              type="number"
              min={TERMINAL_FONT_SIZE_MIN}
              max={TERMINAL_FONT_SIZE_MAX}
              step={1}
              value={terminalFontSize}
              aria-label={t('settings.terminal.fontSize.label', 'Font size')}
              className="w-24"
              onChange={(event) => {
                if (Number.isFinite(event.target.valueAsNumber)) {
                  onTerminalFontSizeChange(normalizeTerminalFontSize(event.target.valueAsNumber));
                }
              }}
            />
          </CompactRow>
          <div
            aria-label={t('settings.terminal.preview', 'Terminal preview')}
            className="overflow-hidden border-t border-border/60 bg-[var(--terminal-background)] text-[var(--terminal-foreground)]"
          >
            <div className="flex h-6 items-center gap-1.5 border-b border-white/10 bg-black/10 px-3 text-[10px] text-[var(--terminal-foreground)]/60">
              <SquareTerminal className="h-3 w-3" aria-hidden="true" />
              <span>lody</span>
            </div>
            <div
              className="flex h-11 min-w-0 items-center gap-2 px-3"
              style={{
                fontFamily: buildTerminalFontPreviewFamily(terminalFontFamily),
                fontSize: `${terminalFontSize}px`,
                lineHeight: 1.2,
              }}
            >
              <span className="shrink-0 text-[var(--terminal-ansi-green)]" aria-hidden="true">
                $
              </span>
              <code
                className="min-w-0 truncate whitespace-nowrap"
                style={{ fontFamily: 'inherit' }}
              >
                npx lody daemon start
              </code>
              <span
                className="h-[1em] w-[0.5em] shrink-0 bg-[var(--terminal-cursor)] opacity-80"
                aria-hidden="true"
              />
            </div>
          </div>
        </CompactSection>
      ) : null}
    </div>
  );
}

function DesktopAppearanceSettings() {
  const { theme, setTheme, previewTheme } = useTheme();
  const [conversationFontSize, setConversationFontSize] = useAtom(conversationFontSizeAtom);
  const [interfaceFontFamily, setInterfaceFontFamily] = useAtom(interfaceFontFamilyAtom);
  const [terminalFontFamily, setTerminalFontFamily] = useAtom(terminalFontFamilyAtom);
  const [terminalFontSize, setTerminalFontSize] = useAtom(terminalFontSizeAtom);
  const [systemFontFamilies, setSystemFontFamilies] = useState<string[]>([]);
  const [systemFontLoadState, setSystemFontLoadState] = useState<SystemFontLoadState>('idle');
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const savedThemeRef = useRef<Theme>(theme);

  const handleThemePreview = useCallback(
    (value: Theme) => {
      previewTheme(value);
    },
    [previewTheme]
  );
  const handleThemeCommit = useCallback(
    (value: Theme) => {
      savedThemeRef.current = value;
      setTheme(value);
    },
    [setTheme]
  );
  const handleThemeCancel = useCallback(() => {
    setTheme(savedThemeRef.current);
  }, [setTheme]);

  const handleSystemFontMenuOpen = useCallback(() => {
    if (systemFontLoadState === 'loading' || systemFontLoadState === 'loaded') return;

    const fontRequest = listSystemFontFamilies();
    setSystemFontLoadState('loading');
    void fontRequest
      .then((families) => {
        setSystemFontFamilies(families);
        setSystemFontLoadState('loaded');
      })
      .catch((error: unknown) => {
        console.warn('Failed to enumerate system fonts', error);
        setSystemFontLoadState('error');
      });
  }, [systemFontLoadState]);

  return (
    <AppearanceSettingsView
      theme={theme}
      onThemePreview={handleThemePreview}
      onThemeCommit={handleThemeCommit}
      onThemeCancel={handleThemeCancel}
      conversationFontSize={conversationFontSize}
      onConversationFontSizeChange={setConversationFontSize}
      isElectron={isElectron}
      interfaceFontFamily={interfaceFontFamily}
      onInterfaceFontFamilyChange={setInterfaceFontFamily}
      terminalFontFamily={terminalFontFamily}
      onTerminalFontFamilyChange={setTerminalFontFamily}
      systemFontFamilies={systemFontFamilies}
      systemFontLoadState={systemFontLoadState}
      onSystemFontMenuOpen={handleSystemFontMenuOpen}
      terminalFontSize={terminalFontSize}
      onTerminalFontSizeChange={setTerminalFontSize}
    />
  );
}

export function AppearanceSettingsComponent() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileAppearanceSettings /> : <DesktopAppearanceSettings />;
}
