import { AcpControlAvailability } from '../shared/acp-control-availability';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  ShieldCheck,
  Compass,
  GitBranch,
  Loader2,
  PenLine,
  ShieldOff,
  Eye,
  Monitor,
} from 'lucide-react';
import { AcpSessionSelect, OptionSelector, type AcpSessionSelectOption } from '@/components/shared';
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

const modeIconClassName = 'h-3.5 w-3.5';

/**
 * Shared icon size for agent config logos in compact selectors.
 * The Button component now only applies a default icon size when children do
 * not provide explicit sizing.
 */
export const agentIconClassName = 'h-3 w-3 shrink-0 opacity-80';

/**
 * Get icon for permission mode
 */
export const getModeIcon = (modeId: string | null): ReactNode => {
  switch (modeId) {
    case 'plan':
      return <Compass className={modeIconClassName} />;
    case 'acceptEdits':
      return <PenLine className={modeIconClassName} />;
    case 'dontAsk':
      return <ShieldOff className={modeIconClassName} />;
    case 'read-only':
      return <Eye className={modeIconClassName} />;
    default:
      return <ShieldCheck className={modeIconClassName} />;
  }
};

/**
 * Get selector tag class name based on tone (no border, muted text).
 */
export const getSelectorTagClassName = (_tone: ChatLandingTone): string => {
  return cn(
    'w-auto h-6 px-2 gap-1 rounded-[4px] [&_span]:text-xs [&_span]:leading-tight',
    'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
  );
};

/**
 * Bordered variant for selectors with icons (e.g. agent config with OpenAI/Claude icons).
 */
export const getCompactSelectorTagClassName = (_tone: ChatLandingTone): string => {
  return cn(
    'w-auto h-6 px-2 gap-1 rounded-[4px] border [&_span]:text-xs [&_span]:leading-tight',
    'border-input-border/70 bg-input/80 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
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
  const selectorTagClassName = getSelectorTagClassName(tone);

  if (options.length === 0) {
    return null;
  }

  return (
    <AcpSessionSelect
      tone={tone}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Mode"
      disabled={disabled || options.length === 0}
      align="start"
      icon={getModeIcon(value)}
      className={cn(selectorTagClassName, 'max-w-[12rem]')}
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
        selector.availability ? (
          <AcpControlAvailability
            key={selector.configId}
            selector={selector}
            value={values[selector.configId]}
          />
        ) : selector.type === 'select' ? (
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
      className={cn('h-6 gap-1 rounded-md border-none bg-transparent px-1', className)}
      contentClassName={cn(
        // Branch names get long (feat/…); give the desktop list more room. The 100vw
        // term keeps narrow mobile surfaces viewport-bound.
        'min-w-[20rem] max-w-[min(36rem,calc(100vw-2rem))] p-1',
        contentClassName
      )}
      renderTriggerValue={(option) => (
        <>
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <GitBranch className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate font-normal">
            {loading ? loadingText : (option?.label ?? placeholder ?? '')}
          </span>
        </>
      )}
      renderOption={(option) => (
        <div className="flex min-w-0 flex-col">
          <span className="whitespace-normal break-words leading-snug">{option.label}</span>
          {option.description && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{option.description}</span>
          )}
        </div>
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
  const selectorTagClassName = getSelectorTagClassName(tone);

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
      className={cn(selectorTagClassName, 'max-w-[160px]', className)}
      contentClassName="w-56"
      renderTriggerValue={(option) => (
        <div className="flex min-w-0 items-center gap-1.5" title={option?.label}>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin opacity-70" />
          ) : (
            <Monitor className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          <span className="truncate text-sm font-medium">
            {loading ? loadingText : (option?.label ?? placeholder)}
          </span>
        </div>
      )}
      renderOption={(option) => (
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="h-4 w-4 shrink-0 opacity-70" />
          <span className="truncate text-sm">{option.label}</span>
        </div>
      )}
    />
  );
}
