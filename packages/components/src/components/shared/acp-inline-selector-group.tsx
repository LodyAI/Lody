import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ListChecks, Zap, ZapOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  AcpBooleanConfigOptionSelector,
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
  AcpSelectConfigOptionSelector,
} from './acp-selector-options';
import {
  CLAUDE_FAST_MODE_CONFIG_ID,
  resolveConfigOptionValue,
  resolveOnOffConfigOptionEnabled,
  resolvePlanModeSelectorEnabled,
  toggleOnOffConfigOptionValue,
  togglePlanModeSelectorValue,
} from './acp-selector-options';
import { AcpSessionSelect, type AcpSessionSelectOption } from './acp-session-select';
import { getModeIcon } from '@/components/chat/chat-landing-selectors';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { Toggle } from '@lody/ui/toggle';
import { Tooltip } from '@lody/ui/tooltip';
import { composerSurface } from './composer-surface';

const styles = stylex.create({
  /** Holds a toggle for its tooltip, so a disabled toggle still explains itself. */
  tooltipHost: { display: 'inline-flex', flexShrink: 0 },
});

type RenderConfigSelectorOptions = {
  icon?: ReactNode;
  iconOnly?: boolean;
  placeholder?: string;
  tone: 'light' | 'dark';
  variant?: 'default' | 'text' | 'compact';
  contentClassName?: string;
  values?: Record<string, AcpConfigOptionValue>;
  onChange?: (configId: string, value: AcpConfigOptionValue) => void;
};

const renderConfigSelector = (
  selector: AcpSelectConfigOptionSelector,
  {
    icon,
    iconOnly,
    placeholder,
    tone,
    variant = 'compact',
    contentClassName,
    values,
    onChange,
  }: RenderConfigSelectorOptions
) => (
  <AcpSessionSelect
    key={selector.configId}
    tone={tone}
    variant={variant}
    contentClassName={contentClassName}
    value={resolveConfigOptionValue(selector, values?.[selector.configId]) as string}
    onChange={(value) => onChange?.(selector.configId, value)}
    options={selector.options}
    placeholder={placeholder ?? selector.label}
    disabled={!onChange || selector.options.length === 0}
    align="start"
    showDescription
    icon={icon}
    iconOnly={iconOnly}
    ariaLabel={selector.label}
    triggerTitle={selector.label}
  />
);

const renderBooleanToggle = (
  selector: AcpBooleanConfigOptionSelector,
  {
    values,
    onChange,
  }: {
    values?: Record<string, AcpConfigOptionValue>;
    onChange?: (configId: string, value: AcpConfigOptionValue) => void;
  }
) => {
  const value = resolveConfigOptionValue(selector, values?.[selector.configId]) === true;
  const disabled = !onChange;

  return (
    <Toggle
      key={selector.configId}
      size="mini"
      pressed={value}
      onPressedChange={(pressed) => onChange?.(selector.configId, pressed)}
      aria-label={selector.label}
      title={selector.label}
      disabled={disabled}
    >
      {selector.label}
    </Toggle>
  );
};

const renderFastModeToggle = (
  selector: AcpConfigOptionSelector,
  {
    tooltip,
    values,
    onChange,
  }: {
    tooltip: string;
    values?: Record<string, AcpConfigOptionValue>;
    onChange?: (configId: string, value: AcpConfigOptionValue) => void;
  }
) => {
  const value = resolveOnOffConfigOptionEnabled(selector, values?.[selector.configId]);
  const disabled = !onChange;
  const Icon = value ? Zap : ZapOff;

  return (
    <Tooltip.Root key={selector.configId}>
      <Tooltip.Trigger
        delay={300}
        render={
          <span {...stylex.props(styles.tooltipHost)}>
            <Toggle
              size="mini"
              icon
              pressed={value}
              onPressedChange={() =>
                onChange?.(
                  selector.configId,
                  toggleOnOffConfigOptionValue(selector, values?.[selector.configId])
                )
              }
              aria-label={selector.label}
              disabled={disabled}
            >
              <Icon {...stylex.props(composerSurface.glyph14)} aria-hidden="true" />
            </Toggle>
          </span>
        }
      />
      <Tooltip.Content side="top">{tooltip}</Tooltip.Content>
    </Tooltip.Root>
  );
};

const renderPlanModeToggle = (
  selector: AcpConfigOptionSelector,
  {
    values,
    onChange,
  }: {
    values?: Record<string, AcpConfigOptionValue>;
    onChange?: (configId: string, value: AcpConfigOptionValue) => void;
  }
) => {
  const value = resolvePlanModeSelectorEnabled(selector, values?.[selector.configId]);
  const disabled = !onChange;
  const displayLabel = 'Plan';

  return (
    <Tooltip.Root key={selector.configId}>
      <Tooltip.Trigger
        delay={300}
        render={
          <span {...stylex.props(styles.tooltipHost)}>
            <Toggle
              size="mini"
              pressed={value}
              onPressedChange={() =>
                onChange?.(
                  selector.configId,
                  togglePlanModeSelectorValue(selector, values?.[selector.configId])
                )
              }
              aria-label={selector.label}
              disabled={disabled}
            >
              <ListChecks {...stylex.props(composerSurface.glyph14)} aria-hidden="true" />
              <span>{displayLabel}</span>
            </Toggle>
          </span>
        }
      />
      <Tooltip.Content side="top">{selector.description ?? selector.label}</Tooltip.Content>
    </Tooltip.Root>
  );
};

// ── Footer selectors (inside the input box): model, think level, other ──

export interface AcpFooterSelectorGroupProps {
  tone: 'light' | 'dark';
  modelOptions?: AcpSessionSelectOption[];
  selectedModelId?: string | null;
  onModelChange?: (value: string) => void;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  contentClassName?: string;
}

export function AcpFooterSelectorGroup({
  tone,
  modelOptions = [],
  selectedModelId,
  onModelChange,
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
  contentClassName,
}: AcpFooterSelectorGroupProps) {
  const { modelSelectors, thoughtLevelSelectors, booleanSelectors, otherSelectors } =
    orderAcpConfigOptionSelectors(configOptionSelectors);

  return (
    <>
      {modelOptions.length > 0 ? (
        <AcpSessionSelect
          tone={tone}
          variant="compact"
          value={selectedModelId}
          onChange={(value) => onModelChange?.(value)}
          options={modelOptions}
          placeholder="Model"
          disabled={!onModelChange || modelOptions.length === 0}
          align="start"
          showDescription
          ariaLabel="Model"
          contentClassName={contentClassName}
          triggerTitle="Model"
        />
      ) : modelSelectors[0]?.type === 'select' ? (
        renderConfigSelector(modelSelectors[0], {
          placeholder: 'Model',
          tone,
          values: configOptionValues,
          onChange: onConfigOptionChange,
          contentClassName,
        })
      ) : null}

      {thoughtLevelSelectors.map((selector) =>
        selector.type === 'select'
          ? renderConfigSelector(selector, {
              tone,
              values: configOptionValues,
              onChange: onConfigOptionChange,
              contentClassName,
            })
          : renderBooleanToggle(selector, {
              values: configOptionValues,
              onChange: onConfigOptionChange,
            })
      )}

      {booleanSelectors.map((selector) =>
        renderBooleanToggle(selector, {
          values: configOptionValues,
          onChange: onConfigOptionChange,
        })
      )}

      {otherSelectors.map((selector) =>
        selector.type === 'select'
          ? renderConfigSelector(selector, {
              tone,
              values: configOptionValues,
              onChange: onConfigOptionChange,
              contentClassName,
            })
          : renderBooleanToggle(selector, {
              values: configOptionValues,
              onChange: onConfigOptionChange,
            })
      )}
    </>
  );
}

// ── Bottom bar mode selectors (below the input box, no border) ──

export interface AcpBottomBarModeSelectorProps {
  tone: 'light' | 'dark';
  modeOptions?: AcpSessionSelectOption[];
  selectedModeId?: string | null;
  onModeChange?: (value: string) => void;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  contentClassName?: string;
}

export function AcpBottomBarModeSelector({
  tone,
  modeOptions = [],
  selectedModeId,
  onModeChange,
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
  contentClassName,
}: AcpBottomBarModeSelectorProps) {
  const { t } = useTranslation();
  const { fastModeSelectors, planModeSelectors, permissionModeSelectors, modeSelectors } =
    orderAcpConfigOptionSelectors(configOptionSelectors);
  const explicitPermissionSelector = permissionModeSelectors[0];
  const permissionSelector = explicitPermissionSelector ?? modeSelectors[0];
  const fastModeTooltip = t('chat.fastModeTooltip');
  const claudeFastModeTooltip = t('chat.fastModeTooltipClaude');

  return (
    <>
      {planModeSelectors.map((selector) =>
        renderPlanModeToggle(selector, {
          values: configOptionValues,
          onChange: onConfigOptionChange,
        })
      )}

      {fastModeSelectors.map((selector) =>
        renderFastModeToggle(selector, {
          tooltip:
            selector.configId === CLAUDE_FAST_MODE_CONFIG_ID
              ? claudeFastModeTooltip
              : fastModeTooltip,
          values: configOptionValues,
          onChange: onConfigOptionChange,
        })
      )}

      {!explicitPermissionSelector && modeOptions.length > 0 ? (
        <AcpSessionSelect
          tone={tone}
          value={selectedModeId}
          onChange={(value) => onModeChange?.(value)}
          options={modeOptions}
          placeholder="Mode"
          disabled={!onModeChange || modeOptions.length === 0}
          align="start"
          showDescription
          variant="compact"
          icon={getModeIcon(selectedModeId ?? null)}
          ariaLabel="Permission mode"
          contentClassName={contentClassName}
          triggerTitle="Permission mode"
        />
      ) : permissionSelector?.type === 'select' ? (
        renderConfigSelector(permissionSelector, {
          icon: getModeIcon(
            (resolveConfigOptionValue(
              permissionSelector,
              configOptionValues?.[permissionSelector.configId]
            ) as string) ?? null
          ),
          placeholder: 'Mode',
          tone,
          contentClassName,
          values: configOptionValues,
          onChange: onConfigOptionChange,
        })
      ) : null}
    </>
  );
}

// ── Legacy combined group (re-export for backward compat) ──

export interface AcpInlineSelectorGroupProps {
  tone: 'light' | 'dark';
  modeOptions?: AcpSessionSelectOption[];
  selectedModeId?: string | null;
  onModeChange?: (value: string) => void;
  modelOptions?: AcpSessionSelectOption[];
  selectedModelId?: string | null;
  onModelChange?: (value: string) => void;
  configOptionSelectors?: AcpConfigOptionSelector[];
  configOptionValues?: Record<string, AcpConfigOptionValue>;
  onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  contentClassName?: string;
}

export function AcpInlineSelectorGroup({
  tone,
  modeOptions = [],
  selectedModeId,
  onModeChange,
  modelOptions = [],
  selectedModelId,
  onModelChange,
  configOptionSelectors = [],
  configOptionValues,
  onConfigOptionChange,
  contentClassName,
}: AcpInlineSelectorGroupProps) {
  return (
    <>
      <AcpFooterSelectorGroup
        tone={tone}
        modelOptions={modelOptions}
        selectedModelId={selectedModelId}
        onModelChange={onModelChange}
        configOptionSelectors={configOptionSelectors}
        configOptionValues={configOptionValues}
        onConfigOptionChange={onConfigOptionChange}
        contentClassName={contentClassName}
      />
      <AcpBottomBarModeSelector
        tone={tone}
        modeOptions={modeOptions}
        selectedModeId={selectedModeId}
        onModeChange={onModeChange}
        configOptionSelectors={configOptionSelectors}
        configOptionValues={configOptionValues}
        onConfigOptionChange={onConfigOptionChange}
        contentClassName={contentClassName}
      />
    </>
  );
}
