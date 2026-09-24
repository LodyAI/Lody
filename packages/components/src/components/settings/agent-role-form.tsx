import { useId, type FormEvent } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  AGENT_ROLE_NAME_MAX_LENGTH,
  DEFAULT_AGENT_ROLE_EMOJI,
  type AgentConfigId,
  type MachineId,
} from '@lody/shared';
import type {
  AcpConfigOptionSelector,
  AcpSelectorOptions,
} from '@/components/shared/acp-selector-options';
import {
  selectAuthorableAgentRoleConfigOptions,
  type AgentRoleFormError,
  type AgentRoleFormValue,
  type AgentRoleRunConfigIssue,
} from '@/lib/agent-role-form';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Field as UiField } from '@lody/ui/field';
import { Select } from '@lody/ui/select';
import { Switch } from '@lody/ui/switch';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { EmojiField } from './emoji-field';
import { Field, FormMessage, Section } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const styles = stylex.create({
  offline: { fontSize: '10px', color: colors.secondaryLabel },
  option: { display: 'flex', alignItems: 'center', gap: space[1.5] },
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
  machines: readonly AgentRoleMachineOption[];
  /** Configs on the selected machine only — a Role binds one exact pair. */
  agentConfigs: readonly AgentRoleAgentConfigOption[];
  /** Capability-derived controls for the selected config, or null when none is selected. */
  selectorOptions: AcpSelectorOptions | null;
  /** Parts of the saved run config the selected agent no longer supports. */
  issues: readonly AgentRoleRunConfigIssue[];
  errors: readonly AgentRoleFormError[];
  submitting?: boolean;
  /** A write that failed, or one that is saved locally but not yet synced. */
  error?: string;
  isEditing?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  className?: string;
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
}: AgentRoleFormProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const update = (patch: Partial<AgentRoleFormValue>) => onChange({ ...value, ...patch });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const configOptionSelectors = selectorOptions
    ? selectAuthorableAgentRoleConfigOptions(selectorOptions.configOptionSelectors)
    : [];
  const capabilitiesUnavailable = selectorOptions?.capabilityAuthority === 'unavailable';
  const hasError = (code: AgentRoleFormError) => errors.includes(code);

  return (
    <form {...withClassName(stylex.props(catalog.editorForm), className)} onSubmit={submit}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {/* The Role's own label, shown as itself rather than inside a titled
            card: an emoji and a name need no section heading to be read. */}
        <div {...stylex.props(catalog.stack)}>
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

        <Section
          title={t('settings.agentRoles.form.sectionPrompt')}
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
        </Section>

        <Section
          title={t('settings.agentRoles.form.sectionTarget')}
          hint={t('settings.agentRoles.form.sectionTargetHint')}
        >
          <div {...stylex.props(catalog.fieldPair)}>
            <Field label={t('settings.agentRoles.form.machine')}>
              <Select.Root
                items={machines.map((machine) => ({
                  value: machine.machineId,
                  label: machine.label,
                }))}
                value={value.machineId ?? null}
                onValueChange={(machineId) => {
                  if (machineId == null) return;
                  // Changing machine clears the config: an agent config belongs
                  // to exactly one machine, and carrying the old id over is how
                  // a Role would silently point at nothing.
                  update({ machineId: machineId as MachineId, agentConfigId: null });
                }}
              >
                <Select.Trigger
                  aria-label={t('settings.agentRoles.form.machine')}
                  aria-invalid={hasError('machine_required') || undefined}
                >
                  <Select.Value placeholder={t('settings.agentRoles.form.machinePlaceholder')} />
                </Select.Trigger>
                <Select.Content>
                  {machines.map((machine) => (
                    <Select.Item key={machine.machineId} value={machine.machineId}>
                      <span {...stylex.props(styles.option)}>
                        {machine.label}
                        {machine.online ? null : (
                          <span {...stylex.props(styles.offline)}>
                            {t('settings.agentRoles.status.offline')}
                          </span>
                        )}
                      </span>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>
            <Field label={t('settings.agentRoles.form.agentConfig')}>
              <Select.Root
                items={agentConfigs.map((config) => ({
                  value: config.agentConfigId,
                  label: config.label,
                }))}
                value={value.agentConfigId ?? null}
                disabled={!value.machineId || agentConfigs.length === 0}
                onValueChange={(agentConfigId) => {
                  if (agentConfigId == null) return;
                  update({
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
                  aria-invalid={hasError('agent_config_required') || undefined}
                >
                  <Select.Value
                    placeholder={t('settings.agentRoles.form.agentConfigPlaceholder')}
                  />
                </Select.Trigger>
                <Select.Content>
                  {agentConfigs.map((config) => (
                    <Select.Item key={config.agentConfigId} value={config.agentConfigId}>
                      {config.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>
          </div>
          {value.machineId && agentConfigs.length === 0 ? (
            <FormMessage tone="warning">{t('settings.agentRoles.form.noAgentConfigs')}</FormMessage>
          ) : null}
        </Section>

        {value.agentConfigId ? (
          <Section
            title={t('settings.agentRoles.form.sectionRunConfig')}
            hint={t('settings.agentRoles.form.sectionRunConfigHint')}
          >
            {capabilitiesUnavailable || !selectorOptions ? (
              <FormMessage tone="warning">
                {t('settings.agentRoles.form.capabilitiesUnavailable')}
              </FormMessage>
            ) : (
              <>
                {selectorOptions.modelOptions.length > 0 ? (
                  <Field label={t('settings.agentRoles.form.model')}>
                    <ValueSelect
                      label={t('settings.agentRoles.form.model')}
                      value={value.modelId}
                      options={selectorOptions.modelOptions}
                      onChange={(modelId) => update({ modelId })}
                    />
                  </Field>
                ) : null}
                {selectorOptions.modeOptions.length > 0 ? (
                  <Field label={t('settings.agentRoles.form.mode')}>
                    <ValueSelect
                      label={t('settings.agentRoles.form.mode')}
                      value={value.modeId}
                      options={selectorOptions.modeOptions}
                      onChange={(modeId) => update({ modeId })}
                    />
                  </Field>
                ) : null}
                {configOptionSelectors.map((selector) => (
                  <ConfigOptionField
                    key={selector.configId}
                    selector={selector}
                    value={value.configOptionValues[selector.configId]}
                    onChange={(next) =>
                      update({
                        configOptionValues: {
                          ...value.configOptionValues,
                          [selector.configId]: next,
                        },
                      })
                    }
                  />
                ))}
              </>
            )}
            {issues.length > 0 ? (
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
            ) : null}
          </Section>
        ) : null}

        {/* Stated rather than left to be discovered: a Role looks like a
            standing assistant, so its owner has to be told the sessions it
            creates keep nothing between them. */}
        <div {...stylex.props(surface.formBlock)}>
          <p {...stylex.props(catalog.blockTitle)}>{t('settings.agentRoles.form.memory')}</p>
          <p {...stylex.props(catalog.blockHint)}>{t('settings.agentRoles.form.memoryHint')}</p>
        </div>

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

/**
 * The Role's glyph: the current emoji, and a picker behind it.
 *
 * An always-filled button rather than a text field. Typing an emoji means
 * knowing the OS shortcut, and an empty slot makes "no emoji" look like an
 * unfinished form — so the button shows the default glyph and clicking it is a
 * change, the way a Notion page icon works.
 */
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

function ConfigOptionField({
  selector,
  value,
  onChange,
}: {
  selector: AcpConfigOptionSelector;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const fieldId = useId();
  if (selector.type === 'boolean') {
    return (
      <div {...stylex.props(catalog.blockRow)}>
        <div {...stylex.props(catalog.blockText)}>
          <UiField.Label htmlFor={fieldId}>{selector.label}</UiField.Label>
          {selector.description ? (
            <p {...stylex.props(catalog.blockHint)}>{selector.description}</p>
          ) : null}
        </div>
        <Switch
          id={fieldId}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
        />
      </div>
    );
  }

  return (
    <Field label={selector.label} hint={selector.description}>
      <ValueSelect
        label={selector.label}
        value={typeof value === 'string' ? value : null}
        options={selector.options}
        onChange={onChange}
      />
    </Field>
  );
}
