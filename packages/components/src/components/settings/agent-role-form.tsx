import { Fragment, useId, type ComponentType, type FormEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus } from 'lucide-react';
import {
  AGENT_ROLE_ALIAS_MAX_LENGTH,
  AGENT_ROLE_NAME_MAX_LENGTH,
  getAgentRoleTargetMentionSlug,
  normalizeAgentRoleDescription,
  DEFAULT_AGENT_ROLE_EMOJI,
  type AgentConfigId,
  type MachineId,
} from '@lody/shared';
import type { AcpSelectorOptions } from '@/components/shared/acp-selector-options';
import {
  createAgentRoleTargetFormValue,
  getAgentRoleFormTarget,
  putAgentRoleFormTarget,
  removeAgentRoleFormTarget,
  selectAuthorableAgentRoleConfigOptions,
  type AgentRoleFormError,
  type AgentRoleFormValue,
  type AgentRoleRunConfigIssue,
  type AgentRoleTargetFormValue,
} from '@/lib/agent-role-form';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Menu } from '@lody/ui/menu';
import { Field as UiField } from '@lody/ui/field';
import { Select } from '@lody/ui/select';
import { Switch } from '@lody/ui/switch';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease, space, text as uiText } from '@lody/ui/tokens/scales.stylex';
import { EmojiField } from './emoji-field';
import { Field, FormMessage } from './form-primitives';
import { SettingsInfo } from './settings-info';
import { settingsRecordsCard } from './compact-layout';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const styles = stylex.create({
  /** A target's header: which machine, what runs there, and how to `@` it. */
  targetHead: { width: '100%', gap: space[2] },
  targetMachine: {
    flexShrink: 0,
    maxWidth: '40%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: uiText.footnoteSize,
    color: colors.label,
  },
  targetAgent: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  targetAgentMissing: { color: colors.warning },
  /** The token typed in the composer, set as code so it reads as something to type. */
  mention: {
    flexShrink: 0,
    maxWidth: '55%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingInline: space[1.5],
    height: '20px',
    lineHeight: '20px',
    borderRadius: '4px',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 5%)`,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '11.5px',
    color: colors.secondaryLabel,
  },
  mentionOffline: { color: colors.tertiaryLabel },
  chevron: {
    flexShrink: 0,
    width: '14px',
    height: '14px',
    color: colors.tertiaryLabel,
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevronOpen: { transform: 'rotate(180deg)' },
  /** An open row is one tint deeper; it needs no edge of its own. */
  targetOpen: { backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)` },
  /**
   * The open target's own settings: label on the left, control on the right,
   * so a machine's half-dozen answers read as one compact block under its name.
   */
  targetBody: {
    display: 'grid',
    gridTemplateColumns: '112px minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[2],
    minWidth: 0,
    paddingInlineStart: space[4],
    paddingInlineEnd: space[4],
    paddingTop: space[1],
    paddingBottom: space[3],
  },
  /** A block that spans both columns: messages, memory, the remove action. */
  span: { gridColumn: '1 / -1', minWidth: 0 },
  propLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    fontSize: uiText.footnoteSize,
    color: colors.secondaryLabel,
  },
  headAction: { display: 'flex', marginInlineEnd: `calc(-1 * ${space[2]})` },
  propSwitch: { display: 'flex', justifyContent: 'flex-end' },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minHeight: '28px',
  },
  /** Set like every field label in the form, so "Runs on" reads as one of them. */
  sectionTitle: {
    margin: 0,
    fontSize: uiText.footnoteSize,
    fontWeight: 500,
    color: colors.label,
  },
  /** One rhythm for the whole form: a group's parts sit close, groups keep apart. */
  groups: { display: 'flex', flexDirection: 'column', gap: space[6], minWidth: 0 },
  group: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  dot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '999px',
    backgroundColor: colors.tertiaryLabel,
  },
  dotOnline: { backgroundColor: colors.success },
  removeTarget: { display: 'flex', justifyContent: 'flex-end' },
  issuesTitle: { display: 'block' },
  issues: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    margin: 0,
    marginTop: space[1],
    paddingInlineStart: space[4],
    listStyleType: 'disc',
  },
});

export type AgentRoleMachineOption = {
  machineId: MachineId;
  label: string;
  online: boolean;
};

export type AgentRoleAgentConfigOption = {
  agentConfigId: AgentConfigId;
  label: string;
  agentLabel?: string;
};

export type AgentRoleFormProps = {
  value: AgentRoleFormValue;
  onChange: (value: AgentRoleFormValue) => void;
  /** Machine tabs, in display order: the Role's own machines first. */
  machines: readonly AgentRoleMachineOption[];
  /** Configs on the active machine only — each target binds one exact pair. */
  agentConfigs: readonly AgentRoleAgentConfigOption[];
  /** Capability-derived controls for the active target, or null when it has no config. */
  selectorOptions: AcpSelectorOptions | null;
  /** Parts of the active target's run config its agent does not support. */
  issues: readonly AgentRoleRunConfigIssue[];
  errors: readonly AgentRoleFormError[];
  submitting?: boolean;
  /** A write that failed, or one that is saved locally but not yet synced. */
  error?: string;
  isEditing?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  className?: string;
  xstyle?: stylex.StyleXStyles;
  /** Memory choices for the active machine's target. */
  memoryPicker?: ReactNode;
  /** The agent config name of every target, for the collapsed rows. */
  targetAgentLabels?: Partial<Record<MachineId, string>>;
  /**
   * One "Add machine" menu entry. The owner supplies one that suggests the
   * same agent and settings for that machine; without it a machine is added
   * with nothing selected.
   */
  addMachineItem?: ComponentType<AddMachineItemProps>;
};

export type AddMachineItemProps = {
  machine: AgentRoleMachineOption;
  onAdd: (target: AgentRoleTargetFormValue) => void;
};

/**
 * The Role editor body.
 *
 * Presentational on purpose: the surface that owns the catalog passes machines,
 * configs, and capability-derived selectors in, so this renders the same in
 * Storybook as it does in Settings.
 *
 * Every run-config control is generated from the selected agent's published
 * capabilities. There is no free-text model or reasoning field, and no control
 * appears for an agent whose capabilities are unknown — offering one would let
 * a user author a Role that can only fail at Session creation.
 */
export function AgentRoleForm({
  value,
  onChange,
  machines,
  agentConfigs,
  selectorOptions,
  issues,
  errors,
  submitting = false,
  error,
  isEditing = false,
  onSubmit,
  onCancel,
  className,
  xstyle,
  memoryPicker,
  targetAgentLabels = {},
  addMachineItem: AddMachineItem = PlainAddMachineItem,
}: AgentRoleFormProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const update = (patch: Partial<AgentRoleFormValue>) => onChange({ ...value, ...patch });
  const target = getAgentRoleFormTarget(value);
  const updateTarget = (patch: Partial<AgentRoleTargetFormValue>) => {
    if (target) onChange(putAgentRoleFormTarget(value, { ...target, ...patch }));
  };
  const multiTarget = value.targets.length > 1;
  const machineOf = (machineId: MachineId): AgentRoleMachineOption =>
    machines.find((machine) => machine.machineId === machineId) ?? {
      machineId,
      label: machineId,
      online: false,
    };
  const activeMachine = value.activeMachineId ? machineOf(value.activeMachineId) : undefined;
  const addable = machines.filter(
    (machine) => !value.targets.some((target) => target.machineId === machine.machineId)
  );
  const mentionOf = (target: AgentRoleTargetFormValue) =>
    getAgentRoleTargetMentionSlug({
      roleName: value.name.trim(),
      alias: target.alias.trim(),
      machineName: machineOf(target.machineId).label,
      multiTarget,
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const configOptionSelectors = selectorOptions
    ? selectAuthorableAgentRoleConfigOptions(selectorOptions.configOptionSelectors)
    : [];
  const capabilitiesUnavailable = selectorOptions?.capabilityAuthority === 'unavailable';
  const hasError = (code: AgentRoleFormError) => errors.includes(code);

  /** One answer of the open machine: its name on the left, its control on the right. */
  const prop = (label: string, control: ReactNode, id?: string, info?: ReactNode) => (
    <>
      <span {...stylex.props(styles.propLabel)}>
        {id ? <label htmlFor={id}>{label}</label> : label}
        {info ? <SettingsInfo label={label}>{info}</SettingsInfo> : null}
      </span>
      <div>{control}</div>
    </>
  );

  /** The open machine's own settings: its agent, its `@` name, its run config and memory. */
  const renderTarget = (open: AgentRoleTargetFormValue) => (
    <>
      {prop(
        t('settings.agentRoles.form.agentConfig'),
        <Select.Root
          items={agentConfigs.map((config) => ({
            value: config.agentConfigId,
            label: config.label,
          }))}
          value={open.agentConfigId ?? null}
          disabled={agentConfigs.length === 0}
          onValueChange={(agentConfigId) => {
            if (agentConfigId == null) return;
            updateTarget({
              agentConfigId: agentConfigId as AgentConfigId,
              // Capabilities belong to the config; keeping the old model
              // would carry a selection the new agent may not publish.
              modeId: null,
              modelId: null,
              configOptionValues: {},
            });
          }}
        >
          <Select.Trigger
            aria-label={t('settings.agentRoles.form.agentConfig')}
            aria-invalid={(hasError('agent_config_required') && !open.agentConfigId) || undefined}
          >
            <Select.Value placeholder={t('settings.agentRoles.form.agentConfigPlaceholder')} />
          </Select.Trigger>
          <Select.Content>
            {agentConfigs.map((config) => (
              <Select.Item key={config.agentConfigId} value={config.agentConfigId}>
                {config.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      )}
      {agentConfigs.length === 0 ? (
        <div {...stylex.props(styles.span)}>
          <FormMessage tone="warning">{t('settings.agentRoles.form.noAgentConfigs')}</FormMessage>
        </div>
      ) : null}
      {multiTarget
        ? prop(
            t('settings.agentRoles.form.alias'),
            <>
              <Input
                id={`${fieldId}-alias`}
                autoComplete="off"
                maxLength={AGENT_ROLE_ALIAS_MAX_LENGTH}
                leading={<span aria-hidden="true">@</span>}
                placeholder={mentionOf({ ...open, alias: '' })}
                aria-invalid={hasError('alias_taken') || undefined}
                value={open.alias}
                onChange={(event) => updateTarget({ alias: event.target.value })}
              />
              {hasError('alias_taken') ? (
                <FormMessage tone="error">{t('settings.agentRoles.errors.aliasTaken')}</FormMessage>
              ) : null}
            </>,
            `${fieldId}-alias`
          )
        : null}
      {open.agentConfigId ? (
        capabilitiesUnavailable || !selectorOptions ? (
          <div {...stylex.props(styles.span)}>
            <FormMessage tone="warning">
              {t('settings.agentRoles.form.capabilitiesUnavailable')}
            </FormMessage>
          </div>
        ) : (
          <>
            {selectorOptions.modelOptions.length > 0
              ? prop(
                  t('settings.agentRoles.form.model'),
                  <ValueSelect
                    label={t('settings.agentRoles.form.model')}
                    value={open.modelId}
                    options={selectorOptions.modelOptions}
                    onChange={(modelId) => updateTarget({ modelId })}
                  />
                )
              : null}
            {selectorOptions.modeOptions.length > 0
              ? prop(
                  t('settings.agentRoles.form.mode'),
                  <ValueSelect
                    label={t('settings.agentRoles.form.mode')}
                    value={open.modeId}
                    options={selectorOptions.modeOptions}
                    onChange={(modeId) => updateTarget({ modeId })}
                  />
                )
              : null}
            {configOptionSelectors.map((selector) => {
              const value = open.configOptionValues[selector.configId];
              const onOptionChange = (next: string | boolean) =>
                updateTarget({
                  configOptionValues: { ...open.configOptionValues, [selector.configId]: next },
                });
              const id = `${fieldId}-option-${selector.configId}`;
              return (
                <Fragment key={selector.configId}>
                  {prop(
                    selector.label,
                    selector.type === 'boolean' ? (
                      <div {...stylex.props(styles.propSwitch)}>
                        <Switch
                          id={id}
                          checked={value === true}
                          onCheckedChange={(checked) => onOptionChange(checked)}
                        />
                      </div>
                    ) : (
                      <ValueSelect
                        label={selector.label}
                        value={typeof value === 'string' ? value : null}
                        options={selector.options}
                        onChange={onOptionChange}
                      />
                    ),
                    selector.type === 'boolean' ? id : undefined,
                    selector.description
                  )}
                </Fragment>
              );
            })}
          </>
        )
      ) : null}
      {issues.length > 0 ? (
        <div {...stylex.props(styles.span)}>
          <FormMessage tone="warning">
            <span {...stylex.props(styles.issuesTitle)}>
              {t('settings.agentRoles.form.incompatibleTitle')}
            </span>
            <ul {...stylex.props(styles.issues)}>
              {issues.map((issue, index) => (
                <li key={`${issue.kind}-${index}`}>
                  <RunConfigIssueText issue={issue} />
                </li>
              ))}
            </ul>
          </FormMessage>
        </div>
      ) : null}
      {memoryPicker ? (
        <div {...stylex.props(styles.span, styles.group)}>
          <span {...stylex.props(styles.propLabel)}>{t('settings.agentRoles.form.memory')}</span>
          {memoryPicker}
        </div>
      ) : null}
      <div {...stylex.props(styles.span, styles.removeTarget)}>
        <Button
          type="button"
          size="small"
          variant="ghost"
          tone="destructive"
          onClick={() => onChange(removeAgentRoleFormTarget(value, open.machineId))}
        >
          {t('settings.agentRoles.form.removeFromMachine', {
            machine: activeMachine?.label ?? '',
          })}
        </Button>
      </div>
    </>
  );

  return (
    <form {...withClassName(stylex.props(catalog.editorForm, xstyle), className)} onSubmit={submit}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        <div {...stylex.props(styles.groups)}>
          {/* The Role's own label, shown as itself: an emoji and a name need no
              heading to be read. */}
          <div {...stylex.props(styles.group)}>
            <Input
              id={`${fieldId}-name`}
              autoComplete="off"
              aria-label={t('settings.agentRoles.form.name')}
              leading={
                <EmojiField
                  value={value.emoji}
                  defaultEmoji={DEFAULT_AGENT_ROLE_EMOJI}
                  onChange={(emoji) => update({ emoji })}
                />
              }
              maxLength={AGENT_ROLE_NAME_MAX_LENGTH}
              placeholder={t('settings.agentRoles.form.name')}
              aria-invalid={hasError('name_required') || undefined}
              value={value.name}
              onChange={(event) => update({ name: event.target.value })}
            />
            {hasError('name_taken') ? (
              <FormMessage tone="error">{t('settings.agentRoles.errors.nameTaken')}</FormMessage>
            ) : null}
          </div>

          {/* Where the Role runs comes straight after its name. The list IS the
              set of machines the Role runs on, and each row shows the `@` token
              that runs it there — no default, no fallback. Everything inside a
              row is that machine's alone; the fields below are shared. */}
          <section {...stylex.props(styles.group)} aria-labelledby={`${fieldId}-targets`}>
            <div {...stylex.props(styles.sectionHead)}>
              <h3 id={`${fieldId}-targets`} {...stylex.props(styles.sectionTitle)}>
                {t('settings.agentRoles.form.sectionTarget')}
              </h3>
              {addable.length > 0 ? (
                <span {...stylex.props(styles.headAction)}>
                  <Menu.Root>
                    <Menu.Trigger
                      render={
                        <Button type="button" size="small" variant="ghost">
                          <Plus aria-hidden="true" {...stylex.props(catalog.icon)} />
                          {t('settings.agentRoles.form.addMachine')}
                        </Button>
                      }
                    />
                    <Menu.Content align="end" width="compact">
                      {addable.map((machine) => (
                        <AddMachineItem
                          key={machine.machineId}
                          machine={machine}
                          onAdd={(added) =>
                            onChange({
                              ...putAgentRoleFormTarget(value, added),
                              activeMachineId: added.machineId,
                            })
                          }
                        />
                      ))}
                    </Menu.Content>
                  </Menu.Root>
                </span>
              ) : null}
            </div>
            {value.targets.length === 0 ? (
              <FormMessage tone={machines.length === 0 ? 'warning' : 'error'}>
                {machines.length === 0
                  ? t('settings.agentRoles.form.noMachines')
                  : t('settings.agentRoles.errors.machineRequired')}
              </FormMessage>
            ) : (
              <div {...stylex.props(settingsRecordsCard)}>
                {value.targets.map((candidate, index) => {
                  const machine = machineOf(candidate.machineId);
                  const open = candidate.machineId === value.activeMachineId && !!target;
                  const agentLabel = targetAgentLabels[candidate.machineId];
                  return (
                    <div
                      key={candidate.machineId}
                      data-machine-id={candidate.machineId}
                      {...stylex.props(
                        surface.line,
                        index > 0 && surface.lineRuled,
                        open && styles.targetOpen
                      )}
                    >
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() =>
                          update({ activeMachineId: open ? null : candidate.machineId })
                        }
                        {...stylex.props(catalog.rowMain, surface.pressableLine, styles.targetHead)}
                      >
                        <span
                          aria-hidden="true"
                          {...stylex.props(styles.dot, machine.online && styles.dotOnline)}
                        />
                        <span {...stylex.props(styles.targetMachine)}>{machine.label}</span>
                        <span
                          {...stylex.props(
                            styles.targetAgent,
                            !candidate.agentConfigId && styles.targetAgentMissing
                          )}
                        >
                          {candidate.agentConfigId
                            ? (agentLabel ?? '')
                            : t('settings.agentRoles.form.agentConfigPlaceholder')}
                        </span>
                        {value.name.trim() ? (
                          <span
                            {...stylex.props(
                              styles.mention,
                              !machine.online && styles.mentionOffline
                            )}
                          >
                            @{mentionOf(candidate)}
                          </span>
                        ) : null}
                        <ChevronDown
                          aria-hidden="true"
                          {...stylex.props(styles.chevron, open && styles.chevronOpen)}
                        />
                      </button>
                      {open && target ? (
                        <div {...stylex.props(styles.targetBody)}>{renderTarget(target)}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            {hasError('agent_config_required') && target?.agentConfigId ? (
              <FormMessage tone="error">
                {t('settings.agentRoles.errors.otherMachineIncomplete')}
              </FormMessage>
            ) : null}
          </section>

          <Field
            htmlFor={`${fieldId}-description`}
            label={t('settings.agentRoles.form.description')}
            hint={t('settings.agentRoles.form.descriptionHint')}
          >
            <Textarea
              id={`${fieldId}-description`}
              rows={2}
              resize="none"
              value={value.description}
              onChange={(event) =>
                update({ description: normalizeAgentRoleDescription(event.target.value) })
              }
            />
          </Field>

          <Field
            htmlFor={`${fieldId}-prompt`}
            label={t('settings.agentRoles.form.sectionPrompt')}
            hint={t('settings.agentRoles.form.sectionPromptHint')}
          >
            <Textarea
              id={`${fieldId}-prompt`}
              rows={4}
              resize="none"
              aria-label={t('settings.agentRoles.form.promptPrefix')}
              placeholder={t('settings.agentRoles.form.promptPrefixPlaceholder')}
              value={value.promptPrefix}
              onChange={(event) => update({ promptPrefix: event.target.value })}
            />
          </Field>

          <div {...stylex.props(surface.formBlock, catalog.blockRow)}>
            <div {...stylex.props(catalog.blockText)}>
              <UiField.Label htmlFor={`${fieldId}-share`}>
                {t('settings.agentRoles.form.share')}
              </UiField.Label>
              <p {...stylex.props(catalog.blockHint)}>{t('settings.agentRoles.form.shareHint')}</p>
            </div>
            <Switch
              id={`${fieldId}-share`}
              checked={value.shareWithWorkspace}
              onCheckedChange={(shareWithWorkspace) => update({ shareWithWorkspace })}
            />
          </div>
        </div>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>

      <Dialog.Footer>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={submitting || errors.length > 0}>
          {submitting ? <Spinner size="small" aria-hidden="true" /> : null}
          {isEditing ? t('common.save') : t('settings.agentRoles.form.create')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}

function RunConfigIssueText({ issue }: { issue: AgentRoleRunConfigIssue }) {
  const { t } = useTranslation();
  const describe = (): string => {
    switch (issue.kind) {
      case 'capabilities_unknown':
        return t('settings.agentRoles.issues.capabilitiesUnknown');
      case 'mode_unsupported':
        return t('settings.agentRoles.issues.modeUnsupported', { value: issue.value });
      case 'model_unsupported':
        return t('settings.agentRoles.issues.modelUnsupported', { value: issue.value });
      case 'option_unsupported':
        return t('settings.agentRoles.issues.optionUnsupported', { option: issue.configId });
      case 'option_value_unsupported':
        return t('settings.agentRoles.issues.optionValueUnsupported', {
          option: issue.configId,
          value: issue.value,
        });
      default: {
        const exhaustive: never = issue;
        return String(exhaustive);
      }
    }
  };
  return <>{describe()}</>;
}

/**
 * A capability selector over the values the agent publishes.
 *
 * There is no "agent default" entry: a Role that stores nothing tells its owner
 * nothing about what will run, so the form seeds the agent's own default and the
 * control always shows a concrete choice.
 */
function ValueSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select.Root
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next != null) onChange(next);
      }}
    >
      <Select.Trigger aria-label={label}>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        {options.map((option) => (
          <Select.Item key={option.value} value={option.value}>
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

/** A machine's online state, the same dot in the list and in the add menu. */
export function MachineStatusDot({ online }: { online: boolean }) {
  return <span aria-hidden="true" {...stylex.props(styles.dot, online && styles.dotOnline)} />;
}

/** Adds a machine with nothing selected, for owners without a suggestion. */
function PlainAddMachineItem({ machine, onAdd }: AddMachineItemProps) {
  return (
    <Menu.Item
      icon={<MachineStatusDot online={machine.online} />}
      onClick={() => onAdd(createAgentRoleTargetFormValue(machine.machineId))}
    >
      {machine.label}
    </Menu.Item>
  );
}
