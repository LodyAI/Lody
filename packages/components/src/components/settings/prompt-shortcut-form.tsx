import { useId, useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import { parsePromptShortcut } from '@lody/shared/prompt-shortcuts/compiler';
import {
  DEFAULT_PROMPT_SHORTCUT_EMOJI,
  getShortcutMentionScopeIssues,
  normalizeShortcutEmoji,
  PROMPT_SHORTCUT_LIMITS,
  type PromptShortcut,
  type PromptShortcutScope,
} from '@lody/shared/prompt-shortcuts/model';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Textarea } from '@lody/ui/textarea';
import { Field as UiField } from '@lody/ui/field';
import { Select } from '@lody/ui/select';
import { Switch } from '@lody/ui/switch';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, space } from '@lody/ui/tokens/scales.stylex';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';
import {
  shortcutMentionRanges,
  shortcutTemplateMentions,
} from '@/components/mentions/shortcut-template-ranges';
import { EmojiField } from './emoji-field';
import { FormMessage, Section } from './form-primitives';
import {
  describeShortcutProject,
  ScopeAxisIcon,
  SHORTCUT_SCOPE_NONE,
} from './prompt-shortcut-scope';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const WIDE = '@media (min-width: 640px)';

const styles = stylex.create({
  /** Name and command share a line once there is room; each takes its own well. */
  identity: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: { default: 'stretch', [WIDE]: 'center' },
    gap: space[2],
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
  /** The one-machine axis is a switch with its name, at a field's height and no box. */
  thisMachine: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    minHeight: control.medium,
    minWidth: 0,
  },
  axisIcon: { flexShrink: 0, width: '12px', height: '12px', color: colors.tertiaryLabel },
  axisName: { flexShrink: 0, color: colors.secondaryLabel },
  thisMachineLabel: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    color: colors.secondaryLabel,
  },
  /** A trigger's content: not a <span>, which the trigger line-clamps. */
  trigger: { display: 'flex', flexGrow: 1, alignItems: 'center', gap: space[1.5], minWidth: 0 },
  value: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  shareBlock: { display: 'flex', flexDirection: 'column', gap: space[2] },
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
  canShare,
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
  canShare: boolean;
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
  // A slug the author has typed is theirs; only an untouched one follows the
  // name, so renaming an existing Shortcut never silently moves its command.
  const [slugTouched, setSlugTouched] = useState(() => !isNew || initial.slug.length > 0);
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
  const updateScope = (scope: PromptShortcutScope) =>
    setValue((previous) => ({ ...previous, scope }));
  const blocked = scopeIssues.length > 0;
  const submit = async () => {
    if (saving || blocked) return;
    setError(undefined);
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
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {/* Name and command are the Shortcut's identity, shown as themselves
            rather than inside a titled card — the same opening row as the Role
            editor. The command carries its `/` so what is typed is what shows. */}
        <div {...stylex.props(catalog.stack)}>
          <div {...stylex.props(styles.identity)}>
            <div {...stylex.props(styles.name)}>
              <Input
                id="shortcut-name"
                autoComplete="off"
                aria-label={t('settings.promptShortcuts.name', 'Name')}
                placeholder={t('settings.promptShortcuts.name', 'Name')}
                leading={
                  <EmojiField
                    value={value.emoji ?? ''}
                    defaultEmoji={DEFAULT_PROMPT_SHORTCUT_EMOJI}
                    onChange={(emoji) =>
                      setValue((previous) => ({
                        ...previous,
                        ...(normalizeShortcutEmoji(emoji)
                          ? { emoji: normalizeShortcutEmoji(emoji) }
                          : { emoji: undefined }),
                      }))
                    }
                  />
                }
                value={value.name}
                maxLength={PROMPT_SHORTCUT_LIMITS.name}
                required
                disabled={saving}
                onChange={(event) => {
                  const name = event.target.value;
                  setValue((previous) => ({
                    ...previous,
                    name,
                    slug: slugTouched ? previous.slug : slugify(name),
                  }));
                }}
              />
            </div>
            <div {...stylex.props(styles.command)}>
              <Input
                id="shortcut-slug"
                autoComplete="off"
                aria-label={t('settings.promptShortcuts.command', 'Slash command')}
                placeholder={t('settings.promptShortcuts.commandPlaceholder', 'review-pr')}
                leading={<span aria-hidden="true">/</span>}
                value={value.slug}
                maxLength={PROMPT_SHORTCUT_LIMITS.slug}
                pattern="[a-z0-9][a-z0-9-]*"
                required
                disabled={saving}
                onChange={(event) => {
                  setSlugTouched(true);
                  setValue((previous) => ({ ...previous, slug: slugify(event.target.value) }));
                }}
              />
            </div>
          </div>
          <Input
            id="shortcut-description"
            autoComplete="off"
            aria-label={t('settings.promptShortcuts.description', 'Description (optional)')}
            placeholder={t(
              'settings.promptShortcuts.descriptionPlaceholder',
              'Description — shown in the / menu'
            )}
            value={value.description ?? ''}
            maxLength={PROMPT_SHORTCUT_LIMITS.description}
            disabled={saving}
            onChange={(event) => setValue({ ...value, description: event.target.value })}
          />
        </div>

        <Section
          title={t('settings.promptShortcuts.prompt', 'Prompt')}
          hint={t(
            'settings.promptShortcuts.promptHelp',
            'One message. @ mentions a file or Role, $ a skill, # an issue. The selectors below say where this Shortcut can be called and what @ completes against — None on every axis means anywhere in this workspace.'
          )}
        >
          {/* Scope sits with the prompt rather than in a section of its own: it
              is the same decision as writing the prompt, because it is what the
              `@` menu completes against. */}
          <fieldset disabled={saving} {...stylex.props(styles.axes)}>
            <ScopeSelect
              id="shortcut-project"
              axis="project"
              label={axes.project}
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
            {allowMachineSelection ? (
              <ScopeSelect
                id="shortcut-machine"
                axis="machine"
                label={axes.machineId}
                value={value.scope.machineId ?? ''}
                fallbackLabel={value.scope.machineId}
                options={options.machines}
                onChange={(machineId) =>
                  updateScope({ ...value.scope, machineId: machineId || undefined })
                }
              />
            ) : (
              // One machine exists here, so the axis is a yes/no rather than a
              // list — but it stays the Machine axis, in its own column.
              <div {...stylex.props(styles.thisMachine)}>
                <ScopeAxisIcon axis="machine" {...stylex.props(styles.axisIcon)} />
                <span {...stylex.props(styles.thisMachineLabel)}>{axes.machineId}</span>
                <Switch
                  id={`${fieldId}-this-machine`}
                  aria-label={t('settings.promptShortcuts.thisMachine', 'Limit to this machine')}
                  checked={!!value.scope.machineId}
                  disabled={options.machines.length === 0}
                  onCheckedChange={(checked) =>
                    updateScope({
                      ...value.scope,
                      machineId: checked ? options.machines[0]?.value : undefined,
                    })
                  }
                />
              </div>
            )}
            <ScopeSelect
              id="shortcut-provider"
              axis="agent"
              label={axes.providerKey}
              value={value.scope.providerKey ?? ''}
              fallbackLabel={value.scope.providerKey}
              options={options.providers}
              onChange={(providerKey) =>
                updateScope({ ...value.scope, providerKey: providerKey || undefined })
              }
            />
          </fieldset>
          {renderPrompt ? (
            renderPrompt(promptProps)
          ) : (
            <Textarea
              id="shortcut-prompt"
              aria-label={t('settings.promptShortcuts.prompt', 'Prompt')}
              rows={4}
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
        </Section>

        {canShare && (
          <div {...stylex.props(surface.formBlock, styles.shareBlock)}>
            <div {...stylex.props(catalog.blockRow)}>
              <div {...stylex.props(catalog.blockText)}>
                <UiField.Label htmlFor={`${fieldId}-share`}>
                  {t('settings.promptShortcuts.share', 'Share with workspace')}
                </UiField.Label>
                <p {...stylex.props(catalog.blockHint)}>
                  {t(
                    'settings.promptShortcuts.shareHint',
                    'Off by default. Sharing is separate from where the Shortcut applies.'
                  )}
                </p>
              </div>
              <Switch
                id={`${fieldId}-share`}
                checked={value.visibility === 'workspace'}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setValue({ ...value, visibility: checked ? 'workspace' : 'private' })
                }
              />
            </div>
            {value.visibility === 'workspace' && (
              <FormMessage tone="warning">
                {t(
                  'settings.promptShortcuts.shareWarning',
                  'Workspace members can read and copy this Prompt, its default values and its reference labels. Making it private later cannot remove copies they already received.'
                )}
              </FormMessage>
            )}
          </div>
        )}

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
 * `None` is a real, selectable entry rather than an empty trigger: leaving an
 * axis unset is a decision the author makes, and a blank control reads as an
 * unfinished form.
 */
function ScopeSelect({
  id,
  axis,
  label,
  value,
  fallbackLabel,
  options,
  onChange,
}: {
  id: string;
  axis: 'project' | 'machine' | 'agent';
  label: string;
  value: string;
  /** Printed when the saved value is not in the list — still loading, or gone. */
  fallbackLabel?: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  // A saved axis whose option has not loaded (or no longer exists) must still
  // print what it is set to. An empty trigger reads as "None", which is a
  // different Shortcut from the one the author saved.
  const entries =
    value && !options.some((option) => option.value === value)
      ? [...options, { value, label: fallbackLabel || value }]
      : options;
  return (
    <Select.Root
      items={[
        { value: SHORTCUT_SCOPE_NONE, label: t('settings.promptShortcuts.none', 'None') },
        ...entries,
      ]}
      value={value || SHORTCUT_SCOPE_NONE}
      onValueChange={(next) => {
        if (next != null) onChange(next === SHORTCUT_SCOPE_NONE ? '' : next);
      }}
    >
      <Select.Trigger id={id} aria-label={label}>
        {/* Not a <span>: the trigger line-clamps its direct span children, which
            turns a flex row into a stacked box. The axis names itself here
            because these three sit inline above the prompt with no field label
            of their own. */}
        <div {...stylex.props(styles.trigger)}>
          <ScopeAxisIcon axis={axis} {...stylex.props(styles.axisIcon)} />
          <span {...stylex.props(styles.axisName)}>{label}</span>
          <span {...stylex.props(styles.value)}>
            {entries.find((option) => option.value === value)?.label ??
              t('settings.promptShortcuts.none', 'None')}
          </span>
        </div>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={SHORTCUT_SCOPE_NONE}>
          {t('settings.promptShortcuts.none', 'None')}
        </Select.Item>
        {entries.map((option) => (
          <Select.Item key={option.value} value={option.value}>
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
