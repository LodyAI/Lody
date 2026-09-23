import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { Monitor, Moon, SquareTerminal, Sun } from 'lucide-react';

import {
  conversationFontSizeAtom,
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
import { MobileAppIconSettings } from '@/components/mobile/mobile-app-icon-settings';
import { buildTerminalFontPreviewFamily } from '@/components/terminal/terminal-theme';
import { useIsMobile } from '@/hooks/use-mobile';
import { listSystemFontFamilies } from '@/lib/local-fonts';
import { Combobox } from '@lody/ui/combobox';
import { NumberField } from '@lody/ui/number-field';
import { LanguageSelector } from '../../i18n';
import { useTheme, type Theme } from '../../theme-provider';
import { settingContainerClass } from '.';
import { CompactRow, CompactSection } from './compact-layout';
import { buildConversationFontSizeChoices } from './conversation-font-size-options';
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
): SystemFontOption[] {
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

interface SystemFontOption {
  value: string;
  label: string;
  key?: string;
}

/** Names shown in the default face: a list of fonts set in themselves is unreadable. */
const DEFAULT_FACE = { fontFamily: 'var(--font-sans-default)' };

/**
 * A system font, picked by typing part of its name.
 *
 * A Combobox rather than a button that opens a search box: the list is every
 * installed family, so the field a person types into is the control itself, in
 * the same well as every other field on the page. The first time the list opens
 * is what loads the families.
 */
function SystemFontCombobox({
  value,
  options,
  onChange,
  onOpen,
  searchPlaceholder,
  openLabel,
  emptyText,
  'aria-label': ariaLabel,
}: {
  value: string;
  options: SystemFontOption[];
  onChange: (family: string) => void;
  onOpen: () => void;
  searchPlaceholder: string;
  openLabel: string;
  emptyText: string;
  'aria-label': string;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0] ?? null;
  return (
    <Combobox.Root
      items={options}
      value={selected}
      itemToStringLabel={(option: SystemFontOption) => option.label}
      isItemEqualToValue={(left: SystemFontOption, right: SystemFontOption) =>
        left.value === right.value
      }
      onValueChange={(option: SystemFontOption | null) => {
        if (option) onChange(option.value);
      }}
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <Combobox.InputGroup className="w-full sm:w-[220px]">
        <Combobox.Input
          aria-label={ariaLabel}
          placeholder={searchPlaceholder}
          style={DEFAULT_FACE}
        />
        <Combobox.Trigger aria-label={openLabel} />
      </Combobox.InputGroup>
      <Combobox.Content empty={<Combobox.Empty>{emptyText}</Combobox.Empty>}>
        {(option: SystemFontOption) => (
          <Combobox.Item key={option.key ?? option.value} value={option}>
            <span style={DEFAULT_FACE}>{option.label}</span>
          </Combobox.Item>
        )}
      </Combobox.Content>
    </Combobox.Root>
  );
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
        <span className="flex items-center gap-2">
          <Sun className="h-4 w-4" />
          <span>{t('settings.theme.light')}</span>
        </span>
      ),
    },
    {
      value: 'dark',
      label: (
        <span className="flex items-center gap-2">
          <Moon className="h-4 w-4" />
          <span>{t('settings.theme.dark')}</span>
        </span>
      ),
    },
    {
      value: 'system',
      label: (
        <span className="flex items-center gap-2">
          <Monitor className="h-4 w-4" />
          <span>{t('settings.theme.system')}</span>
        </span>
      ),
    },
  ];

  const conversationFontSizeOptions = useMemo<PreviewSelectOption<string>[]>(
    () =>
      buildConversationFontSizeChoices().map(({ value, labelKey }) => ({
        value,
        label: t(labelKey),
      })),
    [t]
  );

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
            aria-label={t('settings.theme.label')}
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
            <SystemFontCombobox
              value={interfaceFontFamily}
              options={interfaceFontOptions}
              onChange={onInterfaceFontFamilyChange}
              onOpen={onSystemFontMenuOpen}
              aria-label={t('settings.interfaceFontFamily.label', 'Interface font')}
              searchPlaceholder={t(
                'settings.terminal.fontFamily.searchPlaceholder',
                'Search system fonts...'
              )}
              openLabel={t('settings.terminal.fontFamily.openList', 'Show all fonts')}
              emptyText={t('settings.terminal.fontFamily.empty', 'No matching fonts')}
            />
          </CompactRow>
        ) : null}
        <CompactRow label={t('settings.conversationFontSize.label', 'Font size')}>
          <PreviewSelect
            aria-label={t('settings.conversationFontSize.label', 'Font size')}
            value={String(normalizeConversationFontSize(conversationFontSize))}
            options={conversationFontSizeOptions}
            onCommit={(value) => onConversationFontSizeChange(Number(value))}
            triggerClassName="w-full sm:w-[220px]"
          />
        </CompactRow>
      </CompactSection>

      <MobileAppIconSettings />

      {isElectron ? (
        <CompactSection title={t('settings.terminal.title', 'Terminal')}>
          <CompactRow
            label={t('settings.terminal.fontFamily.label', 'Font')}
            helper={fontLoadStatus}
          >
            <SystemFontCombobox
              value={terminalFontFamily}
              options={terminalFontOptions}
              onChange={onTerminalFontFamilyChange}
              onOpen={onSystemFontMenuOpen}
              aria-label={t('settings.terminal.fontFamily.label', 'Font')}
              searchPlaceholder={t(
                'settings.terminal.fontFamily.searchPlaceholder',
                'Search system fonts...'
              )}
              openLabel={t('settings.terminal.fontFamily.openList', 'Show all fonts')}
              emptyText={t('settings.terminal.fontFamily.empty', 'No matching fonts')}
            />
          </CompactRow>
          <CompactRow label={t('settings.terminal.fontSize.label', 'Font size')}>
            {/* A size somebody nudges, so the range owns the clamp and the steppers
                rather than a bare number box parsing what was typed. */}
            <NumberField.Root
              value={terminalFontSize}
              min={TERMINAL_FONT_SIZE_MIN}
              max={TERMINAL_FONT_SIZE_MAX}
              step={1}
              onValueChange={(next) => {
                if (next != null) onTerminalFontSizeChange(normalizeTerminalFontSize(next));
              }}
            >
              <NumberField.Group className="w-28">
                <NumberField.Input
                  aria-label={t('settings.terminal.fontSize.label', 'Font size')}
                />
                <NumberField.Decrement
                  aria-label={t('settings.terminal.fontSize.decrease', 'Decrease font size')}
                />
                <NumberField.Increment
                  aria-label={t('settings.terminal.fontSize.increase', 'Increase font size')}
                />
              </NumberField.Group>
            </NumberField.Root>
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
