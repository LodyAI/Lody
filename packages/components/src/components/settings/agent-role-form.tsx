import { lazy, Suspense, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Switch } from '@/ui/switch';
import { Textarea } from '@/ui/textarea';
import { Field, Section } from './form-primitives';

const AgentRoleEmojiPicker = lazy(() => import('./agent-role-emoji-picker'));

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
    <form className={cn('flex min-h-0 flex-col', className)} onSubmit={submit}>
      <div className="scrollbar-pro min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {/* The Role's own label, shown as itself rather than inside a titled
            card: an emoji and a name need no section heading to be read. */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <AgentRoleEmojiField value={value.emoji} onChange={(emoji) => update({ emoji })} />
            <Input
              id={`${fieldId}-name`}
              autoComplete="off"
              aria-label={t('settings.agentRoles.form.name')}
              className="h-9 min-w-0 flex-1 text-sm"
              maxLength={AGENT_ROLE_NAME_MAX_LENGTH}
              placeholder={t('settings.agentRoles.form.name')}
              aria-invalid={hasError('name_required') || undefined}
              value={value.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>
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
            aria-label={t('settings.agentRoles.form.promptPrefix')}
            className="resize-none font-mono text-xs"
            placeholder={t('settings.agentRoles.form.promptPrefixPlaceholder')}
            value={value.promptPrefix}
            onChange={(event) => update({ promptPrefix: event.target.value })}
          />
        </Section>

        <Section
          title={t('settings.agentRoles.form.sectionTarget')}
          hint={t('settings.agentRoles.form.sectionTargetHint')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.agentRoles.form.machine')}>
              <Select
                value={value.machineId ?? ''}
                onValueChange={(machineId) =>
                  // Changing machine clears the config: an agent config belongs
                  // to exactly one machine, and carrying the old id over is how
                  // a Role would silently point at nothing.
                  update({ machineId: machineId as MachineId, agentConfigId: null })
                }
              >
                <SelectTrigger
                  className="h-9 text-xs"
                  aria-label={t('settings.agentRoles.form.machine')}
                  aria-invalid={hasError('machine_required') || undefined}
                >
                  <SelectValue placeholder={t('settings.agentRoles.form.machinePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {machines.map((machine) => (
                    <SelectItem key={machine.machineId} value={machine.machineId}>
                      <span className="flex items-center gap-1.5">
                        {machine.label}
                        {machine.online ? null : (
                          <span className="text-[10px] text-muted-foreground">
                            {t('settings.agentRoles.status.offline')}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('settings.agentRoles.form.agentConfig')}>
              <Select
                value={value.agentConfigId ?? ''}
                disabled={!value.machineId || agentConfigs.length === 0}
                onValueChange={(agentConfigId) =>
                  update({
                    agentConfigId: agentConfigId as AgentConfigId,
                    // Capabilities belong to the config; keeping the old model
                    // would carry a selection the new agent may not publish.
                    modeId: null,
                    modelId: null,
                    configOptionValues: {},
                  })
                }
              >
                <SelectTrigger
                  className="h-9 text-xs"
                  aria-label={t('settings.agentRoles.form.agentConfig')}
                  aria-invalid={hasError('agent_config_required') || undefined}
                >
                  <SelectValue placeholder={t('settings.agentRoles.form.agentConfigPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {agentConfigs.map((config) => (
                    <SelectItem key={config.agentConfigId} value={config.agentConfigId}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                <span className="block font-medium">
                  {t('settings.agentRoles.form.incompatibleTitle')}
                </span>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
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
        <div className="rounded-lg border border-border/70 bg-card/60 px-3 py-2.5">
          <p className="text-sm">{t('settings.agentRoles.form.memory')}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            {t('settings.agentRoles.form.memoryHint')}
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-card/60 px-3 py-2.5">
          <div className="min-w-0">
            <Label htmlFor={`${fieldId}-share`} className="text-sm">
              {t('settings.agentRoles.form.share')}
            </Label>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {t('settings.agentRoles.form.shareHint')}
            </p>
          </div>
          <Switch
            id={`${fieldId}-share`}
            checked={value.shareWithWorkspace}
            onCheckedChange={(shareWithWorkspace) => update({ shareWithWorkspace })}
          />
        </div>

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={submitting}
          onClick={onCancel}
        >
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="small" disabled={submitting || errors.length > 0}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          {isEditing ? t('common.save') : t('settings.agentRoles.form.create')}
        </Button>
      </footer>
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
function AgentRoleEmojiField({
  value,
  onChange,
}: {
  value: string;
  onChange: (emoji: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The settings editor is a Dialog, whose scroll lock swallows wheel events in
  // a body-level portal — and this popover's whole content is a scrolling list.
  // Same rule as `option-selector.tsx`.
  const portalContainer = open
    ? triggerRef.current?.closest<HTMLElement>('[data-lody-dialog-content]')
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('settings.agentRoles.form.emoji')}
          className="flex h-9 w-11 items-center justify-center rounded-md border border-input-border bg-input-field text-lg leading-none transition-colors hover:bg-hover/60 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span aria-hidden="true">{value || DEFAULT_AGENT_ROLE_EMOJI}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-fit p-0"
        portalContainer={portalContainer}
        // The list is long and the search field wants the caret; taking focus to
        // the popover root would fight the picker's own keyboard handling.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Suspense
          fallback={
            <div className="flex h-[320px] w-72 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          }
        >
          <AgentRoleEmojiPicker
            onSelect={(emoji) => {
              onChange(emoji);
              setOpen(false);
            }}
          />
        </Suspense>
        {value ? (
          <div className="border-t border-border/60 p-1">
            <Button
              type="button"
              variant="ghost"
              size="small"
              className="w-full justify-start"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {t('settings.agentRoles.form.emojiReset', {
                emoji: DEFAULT_AGENT_ROLE_EMOJI,
              })}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
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
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger className="h-9 text-xs" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={fieldId} className="text-xs font-medium">
            {selector.label}
          </Label>
          {selector.description ? (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {selector.description}
            </p>
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

function FormMessage({ tone, children }: { tone: 'error' | 'warning'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-snug',
        tone === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-status-warning/30 bg-status-warning/10 text-foreground/90'
      )}
    >
      <AlertTriangle
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          tone === 'error' ? 'text-destructive' : 'text-status-warning'
        )}
        aria-hidden="true"
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
