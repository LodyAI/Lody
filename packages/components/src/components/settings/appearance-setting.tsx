import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtom } from 'jotai';
import { usePostHog } from '@posthog/react';
import { Monitor, Moon, SquareTerminal, Sun } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

import {
  conversationFontSizeAtom,
  fontLigaturesEnabledAtom,
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
import { Switch } from '@lody/ui/switch';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
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
  fontLigaturesEnabled: boolean;
  onFontLigaturesEnabledChange: (value: boolean) => void;
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

const styles = stylex.create({
  /** A picker takes a fixed column on a wide panel and the row on a narrow one. */
  picker: { width: { default: '100%', '@media (min-width: 640px)': '220px' } },
  stepper: { width: '112px' },
  option: { display: 'flex', alignItems: 'center', gap: space[2] },
  optionIcon: { width: '16px', height: '16px', flexShrink: 0 },
  helperLines: { display: 'flex', flexDirection: 'column', gap: '2px' },
  error: { color: colors.destructive },
  /**
   * A picture of the terminal in the terminal's own palette: it is the line of
   * the card that shows what the two rows above it set.
   */
  terminal: {
    overflow: 'hidden',
    backgroundColor: 'var(--terminal-background)',
    color: 'var(--terminal-foreground)',
  },
  terminalBar: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    height: '24px',
    paddingInline: space[3],
    backgroundColor: 'color-mix(in oklab, var(--terminal-background), black 10%)',
    fontSize: '10px',
    color: 'color-mix(in oklab, var(--terminal-foreground) 60%, transparent)',
  },
  terminalBarIcon: { width: '12px', height: '12px', flexShrink: 0 },
  terminalLine: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    height: '44px',
    paddingInline: space[3],
    lineHeight: 1.2,
  },
  terminalFace: (fontFamily: string, fontSize: string) => ({ fontFamily, fontSize }),
  terminalPrompt: { flexShrink: 0, color: 'var(--terminal-ansi-green)' },
  terminalCommand: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
  },
  terminalCursor: {
    flexShrink: 0,
    width: '0.5em',
    height: '1em',
    backgroundColor: 'var(--terminal-cursor)',
    opacity: 0.8,
  },
});

/**
 * A system font, picked from every installed family.
 *
 * It opens like the Selects above it — one kind of control down the column —
 * and the list it opens starts with a search field, because it is every family
 * on the machine. The first time the list opens is what loads the families.
 */
function SystemFontCombobox({
  value,
  options,
  onChange,
  onOpen,
  searchPlaceholder,
  emptyText,
  'aria-label': ariaLabel,
}: {
  value: string;
  options: SystemFontOption[];
  onChange: (family: string) => void;
  onOpen: () => void;
  searchPlaceholder: string;
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
      <div {...stylex.props(styles.picker)}>
        <Combobox.Button aria-label={ariaLabel} style={DEFAULT_FACE} />
      </div>
      <Combobox.Content
        search={
          <Combobox.Search
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            style={DEFAULT_FACE}
          />
        }
        empty={<Combobox.Empty>{emptyText}</Combobox.Empty>}
      >
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
  fontLigaturesEnabled,
  onFontLigaturesEnabledChange,
}: AppearanceSettingsViewProps) {
  const { t } = useTranslation();

  const themeOptions: PreviewSelectOption<Theme>[] = [
    {
      value: 'light',
      label: (
        <span {...stylex.props(styles.option)}>
          <Sun {...stylex.props(styles.optionIcon)} />
          <span>{t('settings.theme.light')}</span>
        </span>
      ),
    },
    {
      value: 'dark',
      label: (
        <span {...stylex.props(styles.option)}>
          <Moon {...stylex.props(styles.optionIcon)} />
          <span>{t('settings.theme.dark')}</span>
        </span>
      ),
    },
    {
      value: 'system',
      label: (
        <span {...stylex.props(styles.option)}>
          <Monitor {...stylex.props(styles.optionIcon)} />
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
      <span {...stylex.props(styles.error)}>
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
          <div {...stylex.props(styles.picker)}>
            <PreviewSelect
              aria-label={t('settings.theme.label')}
              value={theme}
              options={themeOptions}
              onPreview={onThemePreview}
              onCommit={onThemeCommit}
              onCancel={onThemeCancel}
            />
          </div>
        </CompactRow>
        <CompactRow label={t('settings.language.label')}>
          <div {...stylex.props(styles.picker)}>
            <LanguageSelector />
          </div>
        </CompactRow>
      </CompactSection>

      <CompactSection>
        {isElectron ? (
          <CompactRow
            label={t('settings.interfaceFontFamily.label', 'Interface font')}
            helper={
              <span {...stylex.props(styles.helperLines)}>
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
              emptyText={t('settings.terminal.fontFamily.empty', 'No matching fonts')}
            />
          </CompactRow>
        ) : null}
        <CompactRow label={t('settings.conversationFontSize.label', 'Font size')}>
          <div {...stylex.props(styles.picker)}>
            <PreviewSelect
              aria-label={t('settings.conversationFontSize.label', 'Font size')}
              value={String(normalizeConversationFontSize(conversationFontSize))}
              options={conversationFontSizeOptions}
              onCommit={(value) => onConversationFontSizeChange(Number(value))}
            />
          </div>
        </CompactRow>
      </CompactSection>

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
              emptyText={t('settings.terminal.fontFamily.empty', 'No matching fonts')}
            />
          </CompactRow>
          <CompactRow label={t('settings.terminal.fontSize.label', 'Font size')}>
            {/* A size somebody nudges, so the range owns the clamp and the steppers
                rather than a bare number box parsing what was typed. */}
            <NumberField.Root
              {...stylex.props(styles.stepper)}
              value={terminalFontSize}
              min={TERMINAL_FONT_SIZE_MIN}
              max={TERMINAL_FONT_SIZE_MAX}
              step={1}
              onValueChange={(next) => {
                if (next != null) onTerminalFontSizeChange(normalizeTerminalFontSize(next));
              }}
            >
              <NumberField.Group>
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
            {...stylex.props(styles.terminal)}
          >
            <div {...stylex.props(styles.terminalBar)}>
              <SquareTerminal {...stylex.props(styles.terminalBarIcon)} aria-hidden="true" />
              <span>lody</span>
            </div>
            <div
              {...stylex.props(
                styles.terminalLine,
                styles.terminalFace(
                  buildTerminalFontPreviewFamily(terminalFontFamily),
                  `${terminalFontSize}px`
                )
              )}
            >
              <span {...stylex.props(styles.terminalPrompt)} aria-hidden="true">
                $
              </span>
              <code {...stylex.props(styles.terminalCommand)}>npx lody daemon start</code>
              <span {...stylex.props(styles.terminalCursor)} aria-hidden="true" />
            </div>
          </div>
        </CompactSection>
      ) : null}
      <CompactSection>
        <CompactRow
          label={t('settings.fontLigatures.label', 'Font ligatures')}
          helper={t(
            'settings.fontLigatures.helper',
            'Applies to conversation, code, and tool output.'
          )}
        >
          <Switch
            checked={fontLigaturesEnabled}
            onCheckedChange={onFontLigaturesEnabledChange}
            aria-label={t('settings.fontLigatures.label', 'Font ligatures')}
          />
        </CompactRow>
      </CompactSection>
      <MobileAppIconSettings layout={isElectron ? 'desktop' : 'mobile'} />
    </div>
  );
}

function DesktopAppearanceSettings() {
  const { theme, setTheme, previewTheme } = useTheme();
  const [conversationFontSize, setConversationFontSize] = useAtom(conversationFontSizeAtom);
  const [interfaceFontFamily, setInterfaceFontFamily] = useAtom(interfaceFontFamilyAtom);
  const [terminalFontFamily, setTerminalFontFamily] = useAtom(terminalFontFamilyAtom);
  const [terminalFontSize, setTerminalFontSize] = useAtom(terminalFontSizeAtom);
  const [fontLigaturesEnabled, setFontLigaturesEnabled] = useAtom(fontLigaturesEnabledAtom);
  const [systemFontFamilies, setSystemFontFamilies] = useState<string[]>([]);
  const [systemFontLoadState, setSystemFontLoadState] = useState<SystemFontLoadState>('idle');
  const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const savedThemeRef = useRef<Theme>(theme);
  const postHog = usePostHog();

  const handleConversationFontSizeChange = useCallback(
    (next: ConversationFontSize) => {
      if (next !== conversationFontSize) {
        capturePostHogEvent(postHog, 'settings/font_size_changed', {
          from: conversationFontSize,
          to: next,
        });
      }
      setConversationFontSize(next);
    },
    [conversationFontSize, postHog, setConversationFontSize]
  );

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
      onConversationFontSizeChange={handleConversationFontSizeChange}
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
      fontLigaturesEnabled={fontLigaturesEnabled}
      onFontLigaturesEnabledChange={setFontLigaturesEnabled}
    />
  );
}

export function AppearanceSettingsComponent() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileAppearanceSettings /> : <DesktopAppearanceSettings />;
}
