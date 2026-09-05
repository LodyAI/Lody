import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deriveShortcutVariables,
  parsePromptShortcut,
} from '@lody/shared/prompt-shortcuts/compiler';
import {
  getShortcutMentionScopeIssues,
  type PromptShortcut,
  type PromptShortcutScope,
} from '@lody/shared/prompt-shortcuts/model';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';
import {
  shortcutMentionRanges,
  shortcutTemplateMentions,
} from '@/components/mentions/shortcut-template-ranges';

export type ShortcutScopeOptions = {
  projects: { value: NonNullable<PromptShortcutScope['project']>; label: string }[];
  machines: { value: string; label: string }[];
  providers: { value: string; label: string }[];
};
export type ShortcutPromptEditorProps = {
  value: string;
  onValueChange(value: string): void;
  scope: PromptShortcutScope;
  initialRanges: readonly PersistedMentionRange[];
  onRangesChange(ranges: PersistedMentionRange[]): void;
};

/** Presentational editor: no catalog writes, runtime, machine RPC or cloud hooks. */
export function PromptShortcutForm({
  initial,
  options,
  canShare,
  saving,
  saveBlocked = false,
  allowMachineSelection = true,
  onSave,
  onCancel,
  renderPrompt,
}: {
  initial: PromptShortcut;
  options: ShortcutScopeOptions;
  canShare: boolean;
  saving: boolean;
  onSave(value: PromptShortcut): Promise<void>;
  onCancel(): void;
  renderPrompt?: (props: ShortcutPromptEditorProps) => ReactNode;
  saveBlocked?: boolean;
  allowMachineSelection?: boolean;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [ranges, setRanges] = useState(() => shortcutMentionRanges(initial.mentions));
  const [error, setError] = useState<string>();
  const variables = useMemo(
    () => deriveShortcutVariables(value.prompt, value.variables),
    [value.prompt, value.variables]
  );
  const scopeIssues = useMemo(() => {
    try {
      return shortcutTemplateMentions(value.prompt, ranges).flatMap((mention) => {
        const issues = getShortcutMentionScopeIssues(value.scope, mention.target);
        return issues.length ? [{ mention, issues }] : [];
      });
    } catch {
      // Transient text/range updates and malformed persisted ranges are rejected
      // by the complete save validation; never crash the editor while repairing.
      return [];
    }
  }, [value.prompt, value.scope, ranges]);
  const axes = {
    project: t('settings.promptShortcuts.project', 'Project'),
    machineId: t('settings.promptShortcuts.machine', 'Machine'),
    providerKey: t('settings.promptShortcuts.agent', 'Agent'),
  };
  const scopeLabels = [
    value.scope.project &&
      (options.projects.find(
        (option) => JSON.stringify(option.value) === JSON.stringify(value.scope.project)
      )?.label ??
        (value.scope.project.kind === 'github'
          ? value.scope.project.repository
          : value.scope.project.id)),
    value.scope.machineId &&
      (options.machines.find((option) => option.value === value.scope.machineId)?.label ??
        value.scope.machineId),
    value.scope.providerKey &&
      (options.providers.find((option) => option.value === value.scope.providerKey)?.label ??
        value.scope.providerKey),
  ].filter((label): label is string => !!label);
  const updateScope = (scope: PromptShortcutScope) =>
    setValue((previous) => ({ ...previous, scope }));
  const submit = async () => {
    if (saving || saveBlocked || scopeIssues.length > 0) return;
    setError(undefined);
    try {
      const parsed = parsePromptShortcut({
        ...value,
        variables,
        mentions: shortcutTemplateMentions(value.prompt, ranges),
      });
      await onSave(parsed);
    } catch {
      setError(
        t(
          'settings.promptShortcuts.invalid',
          'Could not save. Check the name, command, mention scope and size limits, then try again.'
        )
      );
    }
  };
  const selectClass =
    'h-9 w-full rounded-md border border-input-border bg-input-field px-2 text-sm disabled:bg-muted';
  const promptProps: ShortcutPromptEditorProps = {
    value: value.prompt,
    onValueChange: (prompt) => setValue((previous) => ({ ...previous, prompt })),
    scope: value.scope,
    // Scope changes remount the source-owning editor. Restore the current draft,
    // including mentions inserted since opening it, not the saved revision.
    initialRanges: ranges,
    onRangesChange: setRanges,
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="shortcut-name">{t('settings.promptShortcuts.name', 'Name')}</Label>
          <Input
            id="shortcut-name"
            value={value.name}
            maxLength={60}
            required
            disabled={saving}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shortcut-slug">
            {t('settings.promptShortcuts.command', 'Slash command')}
          </Label>
          <div className="flex items-center gap-2">
            <span aria-hidden="true">/</span>
            <Input
              id="shortcut-slug"
              value={value.slug}
              maxLength={40}
              pattern="[a-z0-9][a-z0-9-]*"
              required
              disabled={saving}
              onChange={(event) => setValue({ ...value, slug: event.target.value })}
            />
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="shortcut-description">
          {t('settings.promptShortcuts.description', 'Description (optional)')}
        </Label>
        <Input
          id="shortcut-description"
          value={value.description ?? ''}
          maxLength={240}
          disabled={saving}
          onChange={(event) => setValue({ ...value, description: event.target.value })}
        />
      </div>
      <fieldset disabled={saving} className="space-y-2">
        <legend className="text-sm font-medium">
          {t('settings.promptShortcuts.scope', 'Scope')}
        </legend>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.promptShortcuts.scopeHelp',
            'No scope means available throughout this workspace. Select scope before adding restricted mentions.'
          )}
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <Label htmlFor="shortcut-project">
              {t('settings.promptShortcuts.project', 'Project')}
            </Label>
            <select
              id="shortcut-project"
              className={selectClass}
              value={value.scope.project ? JSON.stringify(value.scope.project) : ''}
              onChange={(event) =>
                updateScope({
                  ...value.scope,
                  project: event.target.value ? JSON.parse(event.target.value) : undefined,
                })
              }
            >
              <option value="">{t('settings.promptShortcuts.none', 'None')}</option>
              {options.projects.map((option) => (
                <option key={JSON.stringify(option.value)} value={JSON.stringify(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {allowMachineSelection ? (
            <div>
              <Label htmlFor="shortcut-machine">
                {t('settings.promptShortcuts.machine', 'Machine')}
              </Label>
              <select
                id="shortcut-machine"
                className={selectClass}
                value={value.scope.machineId ?? ''}
                onChange={(event) =>
                  updateScope({ ...value.scope, machineId: event.target.value || undefined })
                }
              >
                <option value="">{t('settings.promptShortcuts.none', 'None')}</option>
                {options.machines.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={!!value.scope.machineId}
                disabled={options.machines.length === 0}
                onCheckedChange={(checked) =>
                  updateScope({
                    ...value.scope,
                    machineId: checked === true ? options.machines[0]?.value : undefined,
                  })
                }
              />
              {t('settings.promptShortcuts.thisMachine', 'Limit to this machine')}
            </label>
          )}
          <div>
            <Label htmlFor="shortcut-provider">
              {t('settings.promptShortcuts.agent', 'Agent')}
            </Label>
            <select
              id="shortcut-provider"
              className={selectClass}
              value={value.scope.providerKey ?? ''}
              onChange={(event) =>
                updateScope({ ...value.scope, providerKey: event.target.value || undefined })
              }
            >
              <option value="">{t('settings.promptShortcuts.none', 'None')}</option>
              {options.providers.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div
          className="flex flex-wrap gap-1.5"
          aria-label={t('settings.promptShortcuts.scope', 'Scope')}
        >
          {(scopeLabels.length
            ? scopeLabels
            : [t('settings.promptShortcuts.workspaceScope', 'Workspace')]
          ).map((label, index) => (
            <Badge
              key={`${index}:${label}`}
              variant="outline"
              className="max-w-full break-all font-normal"
            >
              {label}
            </Badge>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor="shortcut-prompt">{t('settings.promptShortcuts.prompt', 'Prompt')}</Label>
        {renderPrompt ? (
          renderPrompt(promptProps)
        ) : (
          <Textarea
            id="shortcut-prompt"
            className="min-h-48"
            value={value.prompt}
            disabled={saving}
            onChange={(event) => promptProps.onValueChange(event.target.value)}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.promptShortcuts.variablesHelp',
            'Use !{name} for a required variable. Defaults are optional; values are inserted as literal text.'
          )}
        </p>
      </div>
      {scopeIssues.length > 0 && (
        <div role="alert" className="text-sm text-destructive">
          <p>
            {t(
              'settings.promptShortcuts.repairScope',
              'Restore the matching scope or remove these mentions before saving.'
            )}
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {scopeIssues.map(({ mention, issues }) => (
              <li key={mention.start}>
                <code>{mention.label}</code>
                {' — '}
                {t('settings.promptShortcuts.requiredAxes', {
                  defaultValue: 'Requires matching {{axes}}',
                  axes: issues.map((issue) => axes[issue.axis]).join(', '),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {variables.length > 0 && (
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-sm font-medium">
            {t('settings.promptShortcuts.defaults', 'Variable defaults')}
          </legend>
          {variables.slice(0, 20).map((variable) => (
            <div key={variable.name} className="space-y-1">
              <Label htmlFor={`shortcut-variable-${variable.name}`}>{variable.name}</Label>
              <Textarea
                id={`shortcut-variable-${variable.name}`}
                rows={2}
                value={variable.defaultValue ?? ''}
                onChange={(event) =>
                  setValue({
                    ...value,
                    variables: variables.map((item) =>
                      item.name === variable.name
                        ? { ...item, defaultValue: event.target.value }
                        : item
                    ),
                  })
                }
              />
            </div>
          ))}
        </fieldset>
      )}
      {canShare && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={value.visibility === 'workspace'}
            disabled={saving}
            onCheckedChange={(checked) =>
              setValue({ ...value, visibility: checked === true ? 'workspace' : 'private' })
            }
          />
          {t('settings.promptShortcuts.share', 'Share with workspace')}
        </label>
      )}
      {value.visibility === 'workspace' && (
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.promptShortcuts.shareWarning',
            'Workspace members can read and copy this Prompt. Making it private later cannot remove copies they already received.'
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {saveBlocked && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(
            'settings.promptShortcuts.waitPublication',
            'This revision is awaiting publication. Retry the pending publication before saving another revision.'
          )}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={saving || saveBlocked || scopeIssues.length > 0}>
          {t('common.save', 'Save')}
        </Button>
      </div>
    </form>
  );
}
