import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AlertTriangle } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Popover } from '@lody/ui/popover';
import { useTranslation } from 'react-i18next';
import { parsePromptShortcut } from '@lody/shared/prompt-shortcuts/compiler';
import {
  getShortcutMentionScopeIssues,
  PROMPT_SHORTCUT_LIMITS,
  type PromptShortcut,
  type PromptShortcutScope,
} from '@lody/shared/prompt-shortcuts/model';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { Select } from '@lody/ui/select';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';
import {
  shortcutMentionRanges,
  shortcutTemplateMentions,
} from '@/components/mentions/shortcut-template-ranges';
import { Field, FormMessage } from './form-primitives';
import {
  describeShortcutProject,
  ScopeAxisIcon,
  SHORTCUT_SCOPE_NONE,
} from './prompt-shortcut-scope';
import { settingsCatalog as catalog } from './surface';

const WIDE = '@media (min-width: 640px)';

const styles = stylex.create({
  /** One column of labelled fields at one rhythm: a label hugs its field, fields keep apart. */
  fields: { display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 },
  /** Name and command share a line once there is room; each takes its own well. */
  identity: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: 'stretch',
    gap: space[3],
  },
  name: { flexGrow: 1, minWidth: 0 },
  command: { flexShrink: 0, minWidth: 0, width: { default: '100%', [WIDE]: '224px' } },
  /** The three axes: a fieldset stripped to a grid, so `disabled` still reaches them. */
  axes: {
    display: 'grid',
    gridTemplateColumns: { default: 'minmax(0, 1fr)', [WIDE]: 'repeat(3, minmax(0, 1fr))' },
    gap: space[2],
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  axisIcon: { flexShrink: 0, width: '12px', height: '12px', color: colors.tertiaryLabel },
  /** An unset axis reads as the default it is, quieter than a chosen value. */
  unset: { color: colors.secondaryLabel },
  /** A trigger's content: not a <span>, which the trigger line-clamps. */
  trigger: { display: 'flex', flexGrow: 1, alignItems: 'center', gap: space[1.5], minWidth: 0 },
  value: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  issuesTitle: { display: 'block' },
  fieldError: { margin: 0, fontSize: '12px', lineHeight: 1.375, color: colors.destructive },
  issues: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    margin: 0,
    marginTop: space[1],
    paddingInlineStart: space[4],
    listStyleType: 'disc',
  },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  /** The command's live warning floats above the field rather than pushing the
      form down while the draft settles. */
  slugWarningPopup: { pointerEvents: 'none' },
  slugWarning: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[1.5],
    maxWidth: '240px',
    fontSize: '12px',
    lineHeight: 1.375,
    color: colors.label,
  },
  slugWarningMark: {
    flexShrink: 0,
    width: '14px',
    height: '14px',
    marginTop: '1px',
    color: colors.warning,
  },
});

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

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROMPT_SHORTCUT_LIMITS.slug);

/** The schema's command rule, without the length `maxLength` already caps. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The Prompt Shortcut editor body.
 *
 * Presentational on purpose — same sections, spacing and controls as the Agent
 * Role and MCP editors, so the three read as one surface. The container owns
 * the catalog, the machine data and the mention source; this renders the same
 * in Storybook as it does in Settings.
 *
 * "Applies to" is the author's decision, never derived from the active chat or
 * from a mention that was inserted. It is also what the `@` menu completes
 * against, which is why setting a scope and browsing references is one control
 * rather than two that have to agree.
 */
export function PromptShortcutForm({
  initial,
  options,
  saving,
  allowMachineSelection = true,
  isNew = false,
  onSave,
  onCancel,
  renderPrompt,
  className,
}: {
  initial: PromptShortcut;
  options: ShortcutScopeOptions;
  saving: boolean;
  /** Local-only platforms have no remote machine list to choose from. */
  allowMachineSelection?: boolean;
  /** Labels the footer action and lets the slug follow the name while typing. */
  isNew?: boolean;
  onSave(value: PromptShortcut): Promise<void>;
  onCancel(): void;
  renderPrompt?: (props: ShortcutPromptEditorProps) => ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [value, setValue] = useState(initial);
  const [ranges, setRanges] = useState(() => shortcutMentionRanges(initial.mentions));
  const [error, setError] = useState<string>();
  const [nameMissing, setNameMissing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // A slug the author has typed is theirs; only an untouched one follows the
  // name, so renaming an existing Shortcut never silently moves its command.
  const [slugTouched, setSlugTouched] = useState(() => !isNew || initial.slug.length > 0);
  const slugFieldRef = useRef<HTMLDivElement>(null);
  // The field keeps what is typed rather than rejecting mid-token characters:
  // `a-` is a draft on the way to `a-b`, not an error to undo. Validity is
  // reported, not enforced — a valid draft is already the value when focus
  // leaves, and an invalid one keeps its warning instead of being reset.
  const slugInvalid =
    !SLUG_PATTERN.test(value.slug) || value.slug.length > PROMPT_SHORTCUT_LIMITS.slug;
  const showSlugWarning = slugTouched && slugInvalid;
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
  const anyValue = {
    project: t('settings.promptShortcuts.anyProject', 'Any project'),
    machine: t('settings.promptShortcuts.anyMachine', 'Any machine'),
    agent: t('settings.promptShortcuts.anyAgent', 'Any agent'),
  };
  const updateScope = (scope: PromptShortcutScope) =>
    setValue((previous) => ({ ...previous, scope }));
  const blocked = scopeIssues.length > 0;
  const submit = async () => {
    if (saving || blocked) return;
    setError(undefined);
    // Said beside the field, in the form's own voice, rather than by the
    // browser's native bubble — the command and scope warn the same way.
    if (!value.name.trim()) {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    // A rejected save is when the field warning has to be honest too: a
    // command that never passed validation stops following the name.
    setSlugTouched(true);
    try {
      const parsed = parsePromptShortcut({
        ...value,
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
      {...withClassName(stylex.props(catalog.editorForm), className)}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {/* Name and command are the Shortcut's identity, each labelled, on one
            line once there is room. The command carries its `/` so what is
            typed is what shows. */}
        <div {...stylex.props(styles.fields)}>
          <div {...stylex.props(styles.identity)}>
            <div {...stylex.props(styles.name)}>
              <Field
                htmlFor="shortcut-name"
                label={t('settings.promptShortcuts.name', 'Name')}
                hint={
                  nameMissing ? (
                    <span role="alert" {...stylex.props(styles.fieldError)}>
                      {t('settings.promptShortcuts.nameRequired', 'Give this Prompt a name.')}
                    </span>
                  ) : undefined
                }
              >
                <Input
                  ref={nameRef}
                  id="shortcut-name"
                  autoComplete="off"
                  value={value.name}
                  maxLength={PROMPT_SHORTCUT_LIMITS.name}
                  aria-invalid={nameMissing || undefined}
                  disabled={saving}
                  onChange={(event) => {
                    const name = event.target.value;
                    if (name.trim()) setNameMissing(false);
                    setValue((previous) => ({
                      ...previous,
                      name,
                      slug: slugTouched ? previous.slug : slugify(name),
                    }));
                  }}
                />
              </Field>
            </div>
            <div {...stylex.props(styles.command)} ref={slugFieldRef}>
              <Field
                htmlFor="shortcut-slug"
                label={t('settings.promptShortcuts.command', 'Slash command')}
              >
                <Input
                  id="shortcut-slug"
                  autoComplete="off"
                  leading={<span aria-hidden="true">/</span>}
                  value={value.slug}
                  maxLength={PROMPT_SHORTCUT_LIMITS.slug}
                  disabled={saving}
                  aria-invalid={showSlugWarning || undefined}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setValue((previous) => ({ ...previous, slug: event.target.value }));
                  }}
                />
              </Field>
              <Popover.Root open={showSlugWarning}>
                <Popover.Content
                  anchor={slugFieldRef}
                  side="top"
                  align="start"
                  sideOffset={6}
                  // Purely informational: it never takes focus, and the pointer
                  // owns dismissal by fixing or leaving the draft.
                  initialFocus={false}
                  finalFocus={false}
                  className={stylex.props(styles.slugWarningPopup).className}
                >
                  <div {...stylex.props(styles.slugWarning)}>
                    <AlertTriangle aria-hidden="true" {...stylex.props(styles.slugWarningMark)} />
                    {t(
                      'settings.promptShortcuts.commandRule',
                      'Lowercase letters, numbers and dashes, starting with a letter or number.'
                    )}
                  </div>
                </Popover.Content>
              </Popover.Root>
            </div>
          </div>
          <Field
            htmlFor="shortcut-description"
            label={t('settings.promptShortcuts.description', 'Description (optional)')}
          >
            <Input
              id="shortcut-description"
              autoComplete="off"
              placeholder={t(
                'settings.promptShortcuts.descriptionPlaceholder',
                'Shown next to the command in the / menu'
              )}
              value={value.description ?? ''}
              maxLength={PROMPT_SHORTCUT_LIMITS.description}
              disabled={saving}
              onChange={(event) => setValue({ ...value, description: event.target.value })}
            />
          </Field>

          {/* Scope comes before the prompt: the prompt's `@` menu completes
              against it. Each select names its own axis through its icon and
              its "Any …" value, so the group needs only its label. */}
          <Field
            labelId={`${fieldId}-scope`}
            label={t('settings.promptShortcuts.scope', 'Applies to')}
          >
            <fieldset
              disabled={saving}
              aria-labelledby={`${fieldId}-scope`}
              {...stylex.props(styles.axes)}
            >
              <ScopeSelect
                id="shortcut-project"
                axis="project"
                label={axes.project}
                unsetLabel={anyValue.project}
                value={value.scope.project ? JSON.stringify(value.scope.project) : ''}
                fallbackLabel={
                  value.scope.project ? describeShortcutProject(value.scope.project) : undefined
                }
                options={options.projects.map((option) => ({
                  value: JSON.stringify(option.value),
                  label: option.label,
                }))}
                onChange={(next) =>
                  updateScope({ ...value.scope, project: next ? JSON.parse(next) : undefined })
                }
              />
              {/* A local-only host knows one machine, so the axis offers "this
                machine" rather than a list — still the same select. */}
              <ScopeSelect
                id="shortcut-machine"
                axis="machine"
                label={axes.machineId}
                unsetLabel={anyValue.machine}
                value={value.scope.machineId ?? ''}
                fallbackLabel={value.scope.machineId}
                options={
                  allowMachineSelection
                    ? options.machines
                    : options.machines.slice(0, 1).map((machine) => ({
                        value: machine.value,
                        label: t('settings.promptShortcuts.thisMachine', 'This machine'),
                      }))
                }
                onChange={(machineId) =>
                  updateScope({ ...value.scope, machineId: machineId || undefined })
                }
              />
              <ScopeSelect
                id="shortcut-provider"
                axis="agent"
                label={axes.providerKey}
                unsetLabel={anyValue.agent}
                value={value.scope.providerKey ?? ''}
                fallbackLabel={value.scope.providerKey}
                options={options.providers}
                onChange={(providerKey) =>
                  updateScope({ ...value.scope, providerKey: providerKey || undefined })
                }
              />
            </fieldset>
          </Field>

          <Field htmlFor="shortcut-prompt" label={t('settings.promptShortcuts.prompt', 'Prompt')}>
            {renderPrompt ? (
              renderPrompt(promptProps)
            ) : (
              <Textarea
                id="shortcut-prompt"
                rows={6}
                placeholder={t(
                  'settings.promptShortcuts.promptPlaceholder',
                  'Write the prompt you would otherwise retype. @ mentions a file or Role, $ a skill, # an issue.'
                )}
                resize="none"
                value={value.prompt}
                disabled={saving}
                onChange={(event) => promptProps.onValueChange(event.target.value)}
              />
            )}
            {/* The scope can be cleared after the prompt was written, or a
              reference pasted in from elsewhere. This is the one place that says
              the two no longer agree — and it names which reference. */}
            {scopeIssues.length > 0 && (
              <FormMessage tone="error">
                <span {...stylex.props(styles.issuesTitle)}>
                  {t(
                    'settings.promptShortcuts.repairScope',
                    'Restore the matching scope or remove these mentions before saving.'
                  )}
                </span>
                <ul {...stylex.props(styles.issues)}>
                  {scopeIssues.map(({ mention, issues }) => (
                    <li key={mention.start}>
                      <code {...stylex.props(styles.mono)}>{mention.label}</code>
                      {' — '}
                      {t('settings.promptShortcuts.requiredAxes', {
                        defaultValue: 'Requires matching {{axes}}',
                        axes: issues.map((issue) => axes[issue.axis]).join(', '),
                      })}
                    </li>
                  ))}
                </ul>
              </FormMessage>
            )}
          </Field>
        </div>

        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      <Dialog.Footer>
        <Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={saving || blocked}>
          {saving ? <Spinner size="small" aria-hidden="true" /> : null}
          {isNew ? t('settings.promptShortcuts.create', 'Create') : t('common.save', 'Save')}
        </Button>
      </Dialog.Footer>
    </form>
  );
}

/**
 * One "Applies to" axis.
 *
 * The unset entry is a real, selectable choice named for what it means ("Any
 * project"), so the trigger reads as an answer and needs no axis label beside
 * it: the icon and the value already say which axis it is.
 */
function ScopeSelect({
  id,
  axis,
  label,
  unsetLabel,
  value,
  fallbackLabel,
  options,
  onChange,
}: {
  id: string;
  axis: 'project' | 'machine' | 'agent';
  /** The axis name, for assistive technology. */
  label: string;
  unsetLabel: string;
  value: string;
  /** Printed when the saved value is not in the list — still loading, or gone. */
  fallbackLabel?: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  // A saved axis whose option has not loaded (or no longer exists) must still
  // print what it is set to. An empty trigger reads as unset, which is a
  // different Shortcut from the one the author saved.
  const entries =
    value && !options.some((option) => option.value === value)
      ? [...options, { value, label: fallbackLabel || value }]
      : options;
  const selected = entries.find((option) => option.value === value);
  return (
    <Select.Root
      items={[{ value: SHORTCUT_SCOPE_NONE, label: unsetLabel }, ...entries]}
      value={value || SHORTCUT_SCOPE_NONE}
      onValueChange={(next) => {
        if (next != null) onChange(next === SHORTCUT_SCOPE_NONE ? '' : next);
      }}
    >
      <Select.Trigger id={id} aria-label={label}>
        {/* Not a <span>: the trigger line-clamps its direct span children, which
            turns a flex row into a stacked box. */}
        <div {...stylex.props(styles.trigger)}>
          <ScopeAxisIcon axis={axis} {...stylex.props(styles.axisIcon)} />
          <span {...stylex.props(styles.value, !selected && styles.unset)}>
            {selected?.label ?? unsetLabel}
          </span>
        </div>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={SHORTCUT_SCOPE_NONE}>{unsetLabel}</Select.Item>
        {entries.map((option) => (
          <Select.Item key={option.value} value={option.value}>
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
