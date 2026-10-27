import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
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
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { orderAcpConfigOptionSelectors } from '@/lib/acp-selector-order';
import { permissionModeControlLabel, resolvePermissionModeFace } from '@/lib/permission-mode-face';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  pane: {
    display: 'flex',
    height: '17rem',
    width: '16rem',
    flexShrink: 0,
    flexDirection: 'column',
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: themeColors.border,
  },
  header: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'flex-start',
    gap: themeSpace[2.5],
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[3],
    paddingTop: themeSpace[3.5],
  },
  emoji: {
    display: 'flex',
    width: themeSpace[8],
    height: themeSpace[8],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.lg,
    backgroundColor: 'hsl(var(--foreground) / 0.06)',
    fontSize: themeFontSize.base,
    lineHeight: 1,
  },
  headerColumn: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
  },
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: 1.25,
    fontWeight: themeFontWeight.semibold,
    color: themeColors.foreground,
  },
  meta: {
    marginTop: themeSpace[0.5],
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: '11px',
    color: themeColors.mutedForeground,
  },
  agentIcon: {
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
  },
  metaText: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  scroll: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    scrollbarGutter: 'stable',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
  },
  glyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },
  glyphWarning: { color: themeColors.statusWarning },
  promptBlock: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.6)',
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
  },
  promptTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontSize: '10px',
    fontWeight: themeFontWeight.medium,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'hsl(var(--muted-foreground) / 0.7)',
  },
  promptText: {
    marginTop: themeSpace[1.5],
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    fontSize: '11px',
    lineHeight: 1.7,
    color: themeColors.mutedForeground,
  },
  footer: {
    flexShrink: 0,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.6)',
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[2.5],
  },
  editButton: {
    display: 'inline-flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.lg,
    backgroundColor: {
      default: 'hsl(var(--foreground) / 0.06)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground) / 0.1)' },
    },
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[1.5],
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  row: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[2],
  },
  rowGlyph: {
    display: 'flex',
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowGlyphWarning: { color: themeColors.statusWarning },
  rowGlyphMuted: { color: 'hsl(var(--muted-foreground) / 0.7)' },
  rowLabel: {
    flexShrink: 0,
    fontSize: '10.5px',
    lineHeight: 1.25,
    color: 'hsl(var(--muted-foreground) / 0.7)',
  },
  rowValue: {
    marginLeft: 'auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8rem',
    lineHeight: 1.25,
  },
  rowValueWarning: {
    fontWeight: themeFontWeight.medium,
    color: themeColors.statusWarning,
  },
  rowValueDefault: { color: themeColors.foreground },
  rowValueStart: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
    direction: 'rtl',
  },
});

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
   * composer's list is one machine by construction, so naming it there would
   * be a constant that says nothing.
   */
  machineLabel?: string;
};

/**
 * What the highlighted Role runs.
 *
 * One pane for every surface that previews a Role — the composer's Role submenu
 * and the `@` mention menu — because a Role is the same object in both and
 * reading it twice in two vocababularies is how the two drift.
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
  const labelFor = (
    options: ReadonlyArray<{ value: string; label: string; description?: string }>,
    value: string
  ) => options.find((option) => option.value === value);

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

  const paneProps = stylex.props(styles.pane);
  const scrollProps = stylex.props(styles.scroll);

  return (
    <div {...paneProps} className={clsx(paneProps.className, className)}>
      <header {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.emoji)} aria-hidden="true">
          {getAgentRoleEmoji(role)}
        </span>
        <span {...stylex.props(styles.headerColumn)}>
          <span {...stylex.props(styles.name)}>{role.name}</span>
          <span {...stylex.props(styles.meta)}>
            {agentConfig ? (
              <AgentIcon
                cliType={agentConfig.cliType}
                agentType={agentConfig.agentType}
                brandId={agentConfig.brandId}
                env={agentConfig.env}
                className={stylex.props(styles.agentIcon).className}
              />
            ) : null}
            <span {...stylex.props(styles.metaText)}>
              {agentConfig?.name ?? t('settings.agentRoles.unknownAgentConfig')}
              {machineLabel ? ` · ${machineLabel}` : ''}
            </span>
          </span>
        </span>
      </header>

      {/* Only the values scroll. The header says WHICH Role and the footer is
          how to change it — both stay put however long the instruction runs. */}
      <div {...scrollProps} className={clsx(scrollProps.className, 'scrollbar-pro')}>
        <dl {...stylex.props(styles.list)}>
          {modelId ? (
            <DetailRow
              icon={<Cpu {...stylex.props(styles.glyph)} strokeWidth={1.8} />}
              label={t('chat.runConfig.modelLabel', 'Model')}
              value={labelFor(selectorOptions.modelOptions, modelId)?.label ?? modelId}
              /* A model id is prefix-heavy and tail-distinctive
                 (`claude-opus-5` vs `claude-sonnet-5`), so the START is what
                 gives way when the line runs out. */
              elide="start"
            />
          ) : null}
          {thinkingValue ? (
            <DetailRow
              icon={<Brain {...stylex.props(styles.glyph)} strokeWidth={1.8} />}
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
                  <ShieldAlert
                    {...stylex.props(styles.glyph, styles.glyphWarning)}
                    strokeWidth={1.8}
                  />
                ) : (
                  <ShieldCheck {...stylex.props(styles.glyph)} strokeWidth={1.8} />
                )
              }
              label={permissionModeControlLabel(permissionFace, t)}
              value={permissionOption?.label ?? permissionValue}
              tone={permissionIsWarning ? 'warning' : undefined}
            />
          ) : null}
          {extraOptions.map(([configId, value]) => (
            <DetailRow
              key={configId}
              icon={<Sliders {...stylex.props(styles.glyph)} strokeWidth={1.8} />}
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
          <div {...stylex.props(styles.promptBlock)}>
            <p {...stylex.props(styles.promptTitle)}>
              <SquareChevronRight
                {...stylex.props(styles.glyph)}
                strokeWidth={1.8}
                aria-hidden="true"
              />
              {t('chat.runConfig.roles.prompt', 'Instruction')}
            </p>
            <p {...stylex.props(styles.promptText)}>{role.promptPrefix}</p>
          </div>
        ) : null}
      </div>

      {onEdit ? (
        <div {...stylex.props(styles.footer)}>
          <button
            type="button"
            onClick={() => onEdit(role.id)}
            {...stylex.props(styles.editButton)}
          >
            {t('chat.runConfig.roles.edit', 'Edit role')}
            <ArrowRight {...stylex.props(styles.glyph)} aria-hidden="true" />
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
  const glyphProps = stylex.props(
    styles.rowGlyph,
    tone === 'warning' ? styles.rowGlyphWarning : styles.rowGlyphMuted
  );
  const valueProps = stylex.props(
    styles.rowValue,
    tone === 'warning' ? styles.rowValueWarning : styles.rowValueDefault
  );

  return (
    <div {...stylex.props(styles.row)}>
      <span {...glyphProps}>{icon}</span>
      <dt {...stylex.props(styles.rowLabel)}>{label}</dt>
      <dd
        {...valueProps}
        // The full value stays reachable when the line elides it.
        title={value}
      >
        {/* Reversing the direction moves the ellipsis to the start; the inner
            span restores reading order for the text itself. */}
        {elide === 'start' ? (
          <span {...stylex.props(styles.rowValueStart)}>
            <span dir="ltr">{value}</span>
          </span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
