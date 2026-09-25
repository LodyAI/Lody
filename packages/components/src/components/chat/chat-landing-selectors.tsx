import { useMemo } from 'react';
import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ShieldCheck, Compass, GitBranch, PenLine, ShieldOff, Eye, Monitor } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { AcpSessionSelect, OptionSelector, type AcpSessionSelectOption } from '@/components/shared';
import { composerSurface } from '@/components/shared/composer-surface';
import type { OptionSelectorOption } from '@/components/shared/option-selector';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import { cn } from '@/lib/utils';
import { type MachineId } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { useOnlineMachines } from '@/hooks/use-online-machines';

export type ChatLandingTone = 'light' | 'dark';

const MODE_ICON_STROKE_WIDTH = 1.5;

/**
 * Get icon for permission mode
 */
export const getModeIcon = (modeId: string | null): ReactNode => {
  const glyph = stylex.props(composerSurface.glyph14);
  switch (modeId) {
    case 'plan':
      return <Compass {...glyph} strokeWidth={MODE_ICON_STROKE_WIDTH} />;
    case 'acceptEdits':
      return <PenLine {...glyph} strokeWidth={MODE_ICON_STROKE_WIDTH} />;
    case 'dontAsk':
      return <ShieldOff {...glyph} strokeWidth={MODE_ICON_STROKE_WIDTH} />;
    case 'read-only':
      return <Eye {...glyph} strokeWidth={MODE_ICON_STROKE_WIDTH} />;
    default:
      return <ShieldCheck {...glyph} strokeWidth={MODE_ICON_STROKE_WIDTH} />;
  }
};

/**
 * @deprecated Composer selectors take their material from a prop now
 * (`OptionSelector appearance="toolbar"`, `AcpSessionSelect variant="compact"`);
 * kept for the stories that still pass it.
 */
export const getSelectorTagClassName = (_tone: ChatLandingTone): string => {
  return cn(
    'w-auto h-6 px-2 gap-1 rounded-[4px] [&_span]:text-[0.9em] [&_span]:leading-tight',
    'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
  );
};

export interface ModeSelectorProps {
  value: string | null;
  onChange: (value: string) => void;
  options: AcpSessionSelectOption[];
  tone: ChatLandingTone;
  disabled?: boolean;
}

/**
 * Mode selector component for ChatLanding
 */
export function ModeSelector({
  value,
  onChange,
  options,
  tone,
  disabled = false,
}: ModeSelectorProps) {
  if (options.length === 0) {
    return null;
  }

  return (
    <AcpSessionSelect
      tone={tone}
      variant="compact"
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Mode"
      disabled={disabled || options.length === 0}
      align="start"
      icon={getModeIcon(value)}
      className="max-w-[12rem]"
      ariaLabel="Permission mode"
    />
  );
}

export interface ModelSelectorProps {
  value: string | null;
  onChange: (value: string) => void;
  options: AcpSessionSelectOption[];
  tone?: ChatLandingTone;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * Model selector component for ChatLanding
 */
export function ModelSelector({
  value,
  onChange,
  options,
  tone = 'light',
  placeholder = 'Model',
  ariaLabel = 'Model',
  disabled = false,
}: ModelSelectorProps) {
  if (options.length === 0) {
    return null;
  }

  return (
    <AcpSessionSelect
      tone={tone}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      disabled={disabled || options.length === 0}
      align="start"
      ariaLabel={ariaLabel}
    />
  );
}

export interface ConfigOptionSelectorsProps {
  selectors: AcpConfigOptionSelector[];
  values: Record<string, AcpConfigOptionValue>;
  onChange: (configId: string, value: AcpConfigOptionValue) => void;
  tone?: ChatLandingTone;
}

/**
 * Renders dynamic config option selectors from the agent's configOptions.
 */
export function ConfigOptionSelectors({
  selectors,
  values,
  onChange,
  tone = 'light',
}: ConfigOptionSelectorsProps) {
  if (selectors.length === 0) return null;
  return (
    <>
      {selectors.map((selector) =>
        selector.type === 'select' ? (
          <AcpSessionSelect
            key={selector.configId}
            tone={tone}
            value={(values[selector.configId] as string | undefined) ?? selector.currentValue}
            onChange={(v) => onChange(selector.configId, v)}
            options={selector.options}
            placeholder={selector.label}
            disabled={selector.options.length === 0}
            align="start"
            showDescription
            ariaLabel={selector.label}
          />
        ) : null
      )}
    </>
  );
}

export interface BranchSelectorProps {
  value: string | null;
  onChange: (value: string) => void;
  options: AcpSessionSelectOption[];
  tone: ChatLandingTone;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingText?: string;
  className?: string;
  contentClassName?: string;
}

/**
 * Branch selector component for ChatLanding.
 */
export function BranchSelector({
  value,
  onChange,
  options,
  tone,
  placeholder = 'Branch',
  searchPlaceholder,
  emptyText,
  disabled = false,
  loading = false,
  loadingText = 'Loading branches...',
  className,
  contentClassName,
}: BranchSelectorProps) {
  return (
    <OptionSelector
      value={value}
      onSelect={(option) => onChange(option.value)}
      options={options}
      placeholder={placeholder}
      disabled={disabled || loading || options.length === 0}
      align="start"
      side="top"
      avoidCollisions={false}
      tone={tone}
      placeholderIcon={GitBranch}
      searchable={!loading && options.length > 6}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      appearance="toolbar"
      size="sm"
      className={className}
      contentClassName={cn(
        // Branch names get long (feat/…); give the desktop list more room. The 100vw
        // term keeps narrow mobile surfaces viewport-bound.
        'min-w-[20rem] max-w-[min(36rem,calc(100vw-2rem))]',
        contentClassName
      )}
      renderTriggerValue={(option) => (
        <>
          {loading ? (
            <Spinner size="small" label={null} />
          ) : (
            <GitBranch {...stylex.props(composerSurface.glyph16)} aria-hidden="true" />
          )}
          <span {...stylex.props(composerSurface.truncate)}>
            {loading ? loadingText : (option?.label ?? placeholder ?? '')}
          </span>
        </>
      )}
      renderOption={(option) => (
        <span
          {...stylex.props(
            composerSurface.rowText,
            !!option.description && composerSurface.rowTextStacked
          )}
        >
          <span {...stylex.props(composerSurface.rowLabelWrap)}>{option.label}</span>
          {option.description && (
            <span {...stylex.props(composerSurface.rowDescription)}>{option.description}</span>
          )}
        </span>
      )}
      showChevron={false}
    />
  );
}

export interface MachineSelectorProps {
  value: MachineId | null;
  onChange: (machineId: MachineId) => void;
  tone: ChatLandingTone;
  disabled?: boolean;
  /**
   * When true, the selector renders a loading placeholder instead of being
   * hidden — used during initial app launch while machine/agent metadata is
   * still arriving so the picker slot does not flicker in/out.
   */
  loading?: boolean;
  className?: string;
  /** Restrict selectable machines to these IDs. */
  allowedMachineIds?: MachineId[];
}

/**
 * Machine selector component for ChatLanding.
 * Shows online machines as a standalone dropdown.
 */
export function MachineSelector({
  value,
  onChange,
  tone,
  disabled = false,
  loading = false,
  className,
  allowedMachineIds,
}: MachineSelectorProps) {
  const { t } = useTranslation();
  const onlineMachines = useOnlineMachines(allowedMachineIds);
  const machineOptions = useMemo<OptionSelectorOption<string>[]>(() => {
    return onlineMachines.map((m) => ({
      value: m.id,
      label: m.name,
    }));
  }, [onlineMachines]);

  if (!loading && machineOptions.length === 0) {
    return null;
  }

  const placeholder = t('chat.machineSelector.placeholder', 'Machine');
  const loadingText = t('chat.machineSelector.loading', 'Loading machine...');

  return (
    <OptionSelector
      value={value ?? undefined}
      options={machineOptions}
      onSelect={(option) => onChange(option.value as MachineId)}
      placeholder={placeholder}
      placeholderIcon={Monitor}
      disabled={disabled || loading || machineOptions.length === 0}
      align="start"
      tone={tone}
      searchable={!loading && machineOptions.length > 5}
      searchPlaceholder={t('chat.machineSelector.searchPlaceholder', 'Search machines')}
      emptyText={t('chat.machineSelector.emptyText', 'No machines online')}
      appearance="toolbar"
      size="sm"
      className={cn('max-w-[160px]', className)}
      contentClassName="w-56"
      renderTriggerValue={(option) => (
        <>
          {loading ? (
            <Spinner size="small" label={null} />
          ) : (
            <Monitor
              {...stylex.props(composerSurface.glyph14, composerSurface.hint)}
              aria-hidden="true"
            />
          )}
          <span {...stylex.props(composerSurface.truncate)} title={option?.label}>
            {loading ? loadingText : (option?.label ?? placeholder)}
          </span>
        </>
      )}
      renderOption={(option) => (
        <>
          <span {...stylex.props(composerSurface.rowIcon)}>
            <Monitor {...stylex.props(composerSurface.glyph16)} aria-hidden="true" />
          </span>
          <span {...stylex.props(composerSurface.rowLabel)}>{option.label}</span>
        </>
      )}
    />
  );
}
