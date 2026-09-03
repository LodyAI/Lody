import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Brain,
  Cpu,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  SquareChevronRight,
} from 'lucide-react';
import {
  classifyPermissionModeFace,
  getAgentRoleEmoji,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineViewMeta,
} from '@lody/shared';

import { AgentIcon } from '@/components/icons/agent-icon';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { resolvePermissionModeFace } from '@/lib/permission-mode-face';
import { cn } from '@/lib/utils';

/**
 * A Role and what it takes to read it: the bound agent (whose published
 * capabilities turn stored ids into labels) and the machine that agent runs on.
 *
 * Passed in rather than looked up, so the pane stays renderable in a surface
 * that has no workspace machine-visibility context behind it.
 */
export type AgentRoleDetailSubject = {
  role: AgentRole;
  agentConfig?: Pick<
    AgentConfigMeta,
    'name' | 'cliType' | 'agentType' | 'brandId' | 'env' | 'runtimeOverrides'
  >;
  /** Only what reading a Role needs: the capabilities its labels resolve against. */
  machine?: Pick<MachineViewMeta, 'acpCapabilities'> | null;
  /**
   * Named only where a surface offers Roles from more than one machine — the
   * composer's list is one machine by construction, so naming it there would be
   * a constant that says nothing.
   */
  machineLabel?: string;
};

/**
 * What the highlighted Role runs.
 *
 * One pane for every surface that previews a Role — the composer's Role submenu
 * and the `@` mention menu — because a Role is the same object in both and
 * reading it twice in two vocabularies is how the two drift.
 *
 * Values are resolved against the bound agent's own capabilities, so a stored
 * id reads as the label the agent publishes for it ("Full access", not
 * `agent-full-access`). A raw id is the fallback for an agent whose
 * capabilities are not known here, never a blank.
 */
export function AgentRoleDetailPane({
  role,
  agentConfig,
  machine,
  machineLabel,
  onEdit,
  className,
}: AgentRoleDetailSubject & {
  onEdit?: (roleId: AgentRoleId) => void;
  /** The host's box: each menu sizes its own pane to the list beside it. */
  className?: string;
}) {
  const { t } = useTranslation();
  const selectorOptions = useAcpSelectorOptions(
    agentConfig
      ? {
          configId: role.agentConfigId,
          cliType: agentConfig.cliType,
          agentType: agentConfig.agentType,
          runtimeOverrides: agentConfig.runtimeOverrides,
          machine: machine ?? null,
        }
      : undefined
  );

  const { modelId, modeId, configOptionValues } = role.runConfig;
  const { thoughtLevelSelectors } = orderAcpConfigOptionSelectors(
    selectorOptions.configOptionSelectors
  );
  const labelFor = (options: readonly AcpSessionSelectOption[], value: string) =>
    options.find((option) => option.value === value);
  const modelOption = modelId ? labelFor(selectorOptions.modelOptions, modelId) : undefined;

  /* Only what the Role PINS. `resolveConfigOptionValue` would fall back to the
     agent's own current value, which would print a reasoning level or a
     permission this Role never chose — the exact silent substitution the whole
     feature exists to avoid. */
  const pinnedValue = (configId: string | undefined): string | null => {
    const value = configId ? configOptionValues?.[configId] : undefined;
    return typeof value === 'string' ? value : null;
  };

  /* WHICH knob is permission comes from the one shared rule, so this pane, the
     permission button, and the trigger face cannot disagree about it. Only the
     `source` is taken from it: the face resolves a VALUE, and that resolution
     falls back to the agent's own current one. Its description is deliberately
     not shown either — a sentence about what one value allows belongs to the
     Role editor, not to a scan of what is pinned. */
  const permissionFace = resolvePermissionModeFace({
    modeOptions: selectorOptions.modeOptions,
    selectedModeId: modeId ?? null,
    configOptionSelectors: selectorOptions.configOptionSelectors,
  });
  const permissionConfigId =
    permissionFace.source?.kind === 'configOption' ? permissionFace.source.configId : undefined;
  const permissionValue = permissionConfigId
    ? pinnedValue(permissionConfigId)
    : permissionFace.source
      ? (modeId ?? null)
      : null;
  const permissionOption = permissionValue
    ? labelFor(permissionFace.options, permissionValue)
    : undefined;
  const permissionTone = classifyPermissionModeFace(permissionValue);
  const permissionIsWarning = permissionTone.kind !== 'hidden' && permissionTone.tone === 'warning';

  const thinkingSelector = thoughtLevelSelectors.find((selector) => selector.type === 'select');
  const thinkingValue = pinnedValue(thinkingSelector?.configId);

  /* Whatever the agent publishes beyond model / reasoning / permission, minus
     the ones already stated above so nothing is said twice. */
  const statedConfigIds = new Set(
    [
      permissionValue ? permissionConfigId : undefined,
      thinkingValue ? thinkingSelector?.configId : undefined,
    ].filter(Boolean) as string[]
  );
  const extraOptions = Object.entries(configOptionValues ?? {}).filter(
    ([configId]) => !statedConfigIds.has(configId)
  );

  return (
    <div
      className={cn('flex h-[17rem] w-[16rem] shrink-0 flex-col border-l border-border', className)}
    >
      <header className="flex shrink-0 items-start gap-2.5 px-4 pb-3 pt-3.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-base leading-none"
          aria-hidden="true"
        >
          {getAgentRoleEmoji(role)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold leading-tight text-foreground">
            {role.name}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {agentConfig ? (
              <AgentIcon
                cliType={agentConfig.cliType}
                agentType={agentConfig.agentType}
                brandId={agentConfig.brandId}
                env={agentConfig.env}
                className="h-3 w-3 shrink-0"
              />
            ) : null}
            <span className="min-w-0 truncate">
              {agentConfig?.name ?? t('settings.agentRoles.unknownAgentConfig')}
              {machineLabel ? ` · ${machineLabel}` : ''}
            </span>
          </span>
        </span>
      </header>

      {/* Only the values scroll. The header says WHICH Role and the footer is
          how to change it — both stay put however long the instruction runs. */}
      <div className="scrollbar-pro min-h-0 flex-1 overflow-y-auto border-t border-border/60 [scrollbar-gutter:stable]">
        <dl className="flex flex-col gap-2 px-4 py-3">
          {modelId ? (
            <DetailRow
              icon={<Cpu className="h-3.5 w-3.5" strokeWidth={1.8} />}
              label={t('chat.runConfig.modelLabel', 'Model')}
              value={
                modelOption?.provider
                  ? `${modelOption.label} · ${modelOption.provider}`
                  : (modelOption?.label ?? modelId)
              }
              /* A model id is prefix-heavy and tail-distinctive
                 (`claude-opus-5` vs `claude-sonnet-5`), so the START is what
                 gives way when the line runs out. */
              elide="start"
            />
          ) : null}
          {thinkingValue ? (
            <DetailRow
              icon={<Brain className="h-3.5 w-3.5" strokeWidth={1.8} />}
              label={t('chat.runConfig.reasoningLabel', 'Reasoning')}
              value={
                labelFor(thinkingSelector?.options ?? [], thinkingValue)?.label ?? thinkingValue
              }
            />
          ) : null}
          {permissionValue ? (
            <DetailRow
              icon={
                permissionIsWarning ? (
                  <ShieldAlert className="h-3.5 w-3.5 text-status-warning" strokeWidth={1.8} />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
                )
              }
              label={t('chat.runConfig.permissionLabel', 'Permission')}
              value={permissionOption?.label ?? permissionValue}
              tone={permissionIsWarning ? 'warning' : undefined}
            />
          ) : null}
          {extraOptions.map(([configId, value]) => (
            <DetailRow
              key={configId}
              icon={<Sliders className="h-3.5 w-3.5" strokeWidth={1.8} />}
              label={
                selectorOptions.configOptionSelectors.find(
                  (selector) => selector.configId === configId
                )?.label ?? configId
              }
              value={
                typeof value === 'boolean'
                  ? value
                    ? t('chat.runConfig.roles.optionOn', 'On')
                    : t('chat.runConfig.roles.optionOff', 'Off')
                  : value
              }
            />
          ))}
        </dl>

        {role.promptPrefix ? (
          <div className="border-t border-border/60 px-4 py-3">
            <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
              <SquareChevronRight className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
              {t('chat.runConfig.roles.prompt', 'Instruction')}
            </p>
            <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
              {role.promptPrefix}
            </p>
          </div>
        ) : null}
      </div>

      {onEdit ? (
        <div className="shrink-0 border-t border-border/60 px-4 py-2.5">
          <button
            type="button"
            onClick={() => onEdit(role.id)}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground/[0.06] px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
          >
            {t('chat.runConfig.roles.edit', 'Edit role')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One pinned value: glyph, label, value — all on ONE line.
 *
 * `label ……… value` is the same row grammar as the Agent / Model / Reasoning
 * rows this submenu opened from, so the pane reads as a continuation of that
 * menu rather than a second vocabulary. The label sits at the glyph's own size
 * and weight: it is there to name the glyph, not to compete with the value,
 * which is the part being read. Pushing the value to the right edge aligns the
 * column without a fixed label width, which no single width could give across
 * locales. A value that outruns the line is elided rather than wrapped, so the
 * row count stays the pinned-value count.
 */
function DetailRow({
  icon,
  label,
  value,
  tone,
  elide = 'end',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: 'warning';
  /** Which end gives way when the value does not fit. */
  elide?: 'start' | 'end';
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center',
          tone === 'warning' ? 'text-status-warning' : 'text-muted-foreground/70'
        )}
      >
        {icon}
      </span>
      <dt className="shrink-0 text-[10.5px] leading-tight text-muted-foreground/70">{label}</dt>
      <dd
        className={cn(
          'ml-auto min-w-0 truncate text-[0.8rem] leading-tight',
          tone === 'warning' ? 'font-medium text-status-warning' : 'text-foreground'
        )}
        // The full value stays reachable when the line elides it.
        title={value}
      >
        {/* Reversing the direction moves the ellipsis to the start; the inner
            span restores reading order for the text itself. */}
        {elide === 'start' ? (
          <span className="block truncate text-left [direction:rtl]">
            <span dir="ltr">{value}</span>
          </span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
