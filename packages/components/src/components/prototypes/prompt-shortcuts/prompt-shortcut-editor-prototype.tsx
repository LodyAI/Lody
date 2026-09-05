/**
 * PROTOTYPE — the Prompt Shortcut editor (§3.2).
 *
 * One prompt field, not a block list. Blocks were joined with a blank line into
 * a single message anyway, so they bought three buttons of UI for what Enter
 * already does; the model dropped them with the UI.
 *
 * The field is the real mention primitive with live `@` / `$` / `#` triggers, so
 * writing a template here feels like writing a message.
 *
 * "Applies to" is the author's decision, not a derivation. All three axes
 * default to None — the whole workspace — and only the author changes them. The
 * same setting scopes what `@` offers, which is what Settings otherwise lacks:
 * there is no current project or machine here to complete against (§3.3).
 *
 * The cost of setting rather than deriving is that a scope can promise more than
 * the template delivers: pin a project, reference a file in another one, and the
 * Shortcut lists fine but cannot run. So the editor names that reference and
 * blocks Save. That warning IS the design — without it this is a silent trap.
 */

import * as React from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDot,
  FileText,
  GitPullRequest,
  Sparkles,
  UserRoundCog,
} from 'lucide-react';

import { Field, Section } from '@/components/settings/form-primitives';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Mention, MentionContent, MentionInput, MentionItem, MentionLabel } from '@/ui/mention';
import { useMentionContext } from '@/ui/mention';
import { menuGroupLabelClassName } from '@/ui/menu-styles';
import { Switch } from '@/ui/switch';
import {
  agentLabel,
  machineLabel,
  projectLabel,
  PROTOTYPE_AGENTS,
  PROTOTYPE_MACHINES,
  PROTOTYPE_MENTION_CATALOG,
  PROTOTYPE_MENTION_TARGETS,
  PROTOTYPE_PROJECTS,
  PROTOTYPE_SHORTCUTS,
} from './prompt-shortcut-fixtures';
import {
  collectPlaceholderNames,
  findBrokenReferences,
  findOutOfScopeReferences,
  resolveUnusedVariables,
  type PrototypeMentionTarget,
  type PrototypeScope,
  type PrototypeShortcut,
  type PrototypeVariable,
} from './prompt-shortcut-model';
import { derivePrototypeRanges, prototypeChipResolver } from './prompt-shortcut-visuals';

/** The composer's textarea surface, verbatim — including the chip cover colour. */
const PROMPT_SURFACE_CLASS_NAME = cn(
  'w-full rounded-xl border border-foreground/[0.10] bg-background px-3 py-2.5',
  'dark:border-input-border/70 dark:bg-input/90',
  '[--mention-chip-surface:hsl(var(--background))] dark:[--mention-chip-surface:color-mix(in_srgb,hsl(var(--input))_90%,hsl(var(--background)))]'
);

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const KIND_ICON: Record<string, React.ReactNode> = {
  file: <FileText className="size-3.5" aria-hidden="true" />,
  skill: <Sparkles className="size-3.5" aria-hidden="true" />,
  agent_role: <UserRoundCog className="size-3.5" aria-hidden="true" />,
  issue: <CircleDot className="size-3.5" aria-hidden="true" />,
  pr: <GitPullRequest className="size-3.5" aria-hidden="true" />,
};

/** Which trigger character offers which kinds, matching the composer's grammar. */
const TRIGGER_KINDS: Record<string, ReadonlyArray<PrototypeMentionTarget['kind']>> = {
  '@': ['file', 'agent_role'],
  $: ['skill'],
  '#': ['issue', 'pr'],
};

const TRIGGER_GROUP_LABEL: Record<string, string> = {
  '@': 'Files and Agent Roles',
  $: 'Skills',
  '#': 'Issues and Pull Requests',
};

/**
 * The `@` / `$` / `#` menu.
 *
 * Lives inside `<Mention>` so it can read the active trigger and the text typed
 * after it. Items are the fixture catalog narrowed by the browse scope: a file
 * from another project is not offered, because offering it is how a template
 * silently acquires a second project and becomes unsatisfiable.
 */
function PromptMentionMenu({ scope }: { scope: PrototypeScope }) {
  const context = useMentionContext('PromptMentionMenu');
  const trigger = context.trigger;
  const search = context.filterStore.search.toLowerCase();

  const kinds = TRIGGER_KINDS[trigger] ?? [];
  const items = PROTOTYPE_MENTION_TARGETS.filter((target) => {
    if (!kinds.includes(target.kind)) return false;
    // Same rule the out-of-scope check uses, applied before the fact: a
    // reference the scope cannot satisfy is not offered in the first place.
    if (scope.projectId && target.projectId && target.projectId !== scope.projectId) return false;
    if (scope.machineId && target.machineId && target.machineId !== scope.machineId) return false;
    if (scope.agentId && target.agentIds && !target.agentIds.includes(scope.agentId)) return false;
    return target.label.toLowerCase().includes(search);
  });

  const scopeNote = [
    scope.projectId ? projectLabel(scope.projectId) : null,
    scope.machineId ? machineLabel(scope.machineId) : null,
    scope.agentId ? agentLabel(scope.agentId) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <MentionContent className="max-h-72 w-[min(420px,var(--mention-input-width))] overflow-y-auto">
      <div className={menuGroupLabelClassName}>
        {TRIGGER_GROUP_LABEL[trigger] ?? 'References'}
        {scopeNote ? <span className="ms-1 normal-case opacity-70">· {scopeNote}</span> : null}
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Nothing here that “Applies to” allows. Widen it above, or type a different name.
        </div>
      ) : null}
      {items.map((target) => (
        <MentionItem
          key={target.token}
          value={target.token}
          label={target.label}
          // The item carries the literal text, marker included: the primitive
          // replaces the whole trigger span with it.
          insertText={target.token}
          kind={target.kind}
          className="gap-2"
        >
          <span className="text-muted-foreground">{KIND_ICON[target.kind]}</span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-xs">{target.label}</span>
            <span className="truncate text-[10px] text-muted-foreground">
              {[
                target.projectId ? projectLabel(target.projectId) : null,
                target.machineId ? machineLabel(target.machineId) : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Any project or machine'}
            </span>
          </span>
          {target.health && target.health !== 'ok' ? (
            <span className="ms-auto text-[10px] text-status-warning">missing</span>
          ) : null}
        </MentionItem>
      ))}
    </MentionContent>
  );
}

/** One "Applies to" selector. `null` is the default and means the axis is unset. */
function ScopeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (next: string | null) => void;
}) {
  const current = options.find((option) => option.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px] font-normal"
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-[140px] truncate">{current?.label ?? 'None'}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[11px]">{label}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="flex-1 text-xs">None — any {label.toLowerCase()}</span>
          {value === null ? <Check className="size-3.5" /> : null}
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem key={option.id} onSelect={() => onChange(option.id)}>
            <span className="flex-1 truncate text-xs">{option.label}</span>
            {value === option.id ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VariableRow({
  variable,
  onChange,
}: {
  variable: PrototypeVariable;
  onChange: (next: PrototypeVariable) => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <code className="rounded-sm bg-status-warning/12 px-1 py-0.5 font-mono text-[11px] text-status-warning">
          {`!{${variable.name}}`}
        </code>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Switch
              checked={variable.required}
              onCheckedChange={(required) => onChange({ ...variable, required })}
            />
            Required
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Switch
              checked={variable.multiline}
              onCheckedChange={(multiline) => onChange({ ...variable, multiline })}
            />
            Multi-line
          </label>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Input
          value={variable.label ?? ''}
          placeholder="Label"
          className="h-7 text-xs"
          onChange={(event) => onChange({ ...variable, label: event.target.value })}
        />
        <Input
          value={variable.defaultValue ?? ''}
          placeholder="Default value (never a secret)"
          className="h-7 text-xs"
          onChange={(event) => onChange({ ...variable, defaultValue: event.target.value })}
        />
      </div>
      <Input
        value={variable.description ?? ''}
        placeholder="Help text shown to the caller"
        className="mt-2 h-7 text-xs"
        onChange={(event) => onChange({ ...variable, description: event.target.value })}
      />
    </div>
  );
}

export function PromptShortcutEditorPrototype({
  initialShortcut = PROTOTYPE_SHORTCUTS[1] as PrototypeShortcut,
  onClose,
  className,
}: {
  initialShortcut?: PrototypeShortcut;
  onClose?: () => void;
  className?: string;
}) {
  const [draft, setDraft] = React.useState<PrototypeShortcut>(initialShortcut);
  const [slugTouched, setSlugTouched] = React.useState(initialShortcut.slug.length > 0);
  const scope = draft.scope;
  const setScope = (next: Partial<PrototypeScope>) =>
    setDraft((current) => ({ ...current, scope: { ...current.scope, ...next } }));

  const outOfScope = React.useMemo(
    () => findOutOfScopeReferences(draft.prompt, PROTOTYPE_MENTION_CATALOG, draft.scope),
    [draft.prompt, draft.scope]
  );
  const ranges = React.useMemo(() => derivePrototypeRanges(draft.prompt), [draft.prompt]);
  const usedNames = React.useMemo(
    () => collectPlaceholderNames(draft.prompt, PROTOTYPE_MENTION_CATALOG),
    [draft.prompt]
  );
  const unused = React.useMemo(
    () => resolveUnusedVariables(draft, PROTOTYPE_MENTION_CATALOG),
    [draft]
  );

  const variableFor = (name: string): PrototypeVariable =>
    draft.variables.find((entry) => entry.name === name) ?? {
      name,
      required: true,
      multiline: false,
    };

  const updateVariable = (next: PrototypeVariable) =>
    setDraft((current) => ({
      ...current,
      variables: current.variables.some((entry) => entry.name === next.name)
        ? current.variables.map((entry) => (entry.name === next.name ? next : entry))
        : [...current.variables, next],
    }));

  const brokenDependencies = React.useMemo(
    () => findBrokenReferences(draft.prompt, PROTOTYPE_MENTION_CATALOG),
    [draft.prompt]
  );
  // A reference the declared scope cannot satisfy is not a hint. There is no
  // context in which that template runs, so it does not get saved.
  const saveBlocked = outOfScope.length > 0 || draft.name.trim().length === 0;

  return (
    <div className={cn('flex max-h-[85vh] flex-col', className)}>
      <header className="border-b border-border/60 px-4 py-3">
        <h2 className="text-sm font-semibold">
          {initialShortcut.revision === 0 ? 'New Prompt Shortcut' : 'Edit Prompt Shortcut'}
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Saved to this workspace and sent as one message.
        </p>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <Section title="Basics">
          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="prototype-name" label="Name">
              <Input
                id="prototype-name"
                value={draft.name}
                maxLength={60}
                className="h-8 text-sm"
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft((current) => ({
                    ...current,
                    name,
                    slug: slugTouched ? current.slug : slugify(name),
                  }));
                }}
              />
            </Field>
            <Field
              htmlFor="prototype-slug"
              label="Slash command"
              hint="Unique in this workspace. An agent command may share the name — the menu says which is which."
            >
              <div className="flex items-center gap-1">
                <span className="font-mono text-sm text-muted-foreground">/</span>
                <Input
                  id="prototype-slug"
                  value={draft.slug}
                  maxLength={40}
                  className="h-8 font-mono text-sm"
                  onChange={(event) => {
                    setSlugTouched(true);
                    setDraft((current) => ({ ...current, slug: slugify(event.target.value) }));
                  }}
                />
              </div>
            </Field>
          </div>
          <Field htmlFor="prototype-description" label="Description">
            <Input
              id="prototype-description"
              value={draft.description ?? ''}
              maxLength={240}
              className="h-8 text-sm"
              placeholder="Shown in the / menu"
              onChange={(event) =>
                setDraft((current) => ({ ...current, description: event.target.value }))
              }
            />
          </Field>
        </Section>

        <Section
          title="Applies to"
          hint="Where this Shortcut can be called. None on every axis means anywhere in the workspace — that is the default, and nothing you write here changes it for you."
        >
          <div className="flex flex-wrap items-center gap-2">
            <ScopeSelect
              label="Project"
              value={scope.projectId}
              options={PROTOTYPE_PROJECTS}
              onChange={(projectId) => setScope({ projectId })}
            />
            <ScopeSelect
              label="Machine"
              value={scope.machineId}
              options={PROTOTYPE_MACHINES}
              onChange={(machineId) => setScope({ machineId })}
            />
            <ScopeSelect
              label="Agent"
              value={scope.agentId}
              options={PROTOTYPE_AGENTS}
              onChange={(agentId) => setScope({ agentId })}
            />
            {/* No pill row here: each selector already prints its own value,
                and the list is where pills exist because there is no selector. */}
          </div>
        </Section>

        <Section
          title="Prompt"
          hint="@ completes against what “Applies to” allows, so a reference the scope cannot satisfy is never offered."
        >
          <Mention
            inputValue={draft.prompt}
            onInputValueChange={(prompt) => setDraft((current) => ({ ...current, prompt }))}
            mentions={ranges}
            getMentionChip={prototypeChipResolver}
            // No `/`: a Shortcut may not call another Shortcut or an ACP command
            // (§3.3). The menu owns its own filtering, so the primitive's default
            // label match is turned off.
            triggers={['@', '$', '#']}
            onFilter={(options) => options}
            autoCloseOnEmpty={false}
            loop
            className={PROMPT_SURFACE_CLASS_NAME}
          >
            <MentionLabel className="sr-only">Prompt template</MentionLabel>
            <MentionInput
              value={draft.prompt}
              rows={8}
              placeholder="Write the prompt. @ for a file or Role, $ for a skill, # for an issue, !{name} for a value the caller fills in."
              className="resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
            />
            <PromptMentionMenu scope={scope} />
          </Mention>

          {/* The scope above can be widened after the prompt was written, or a
              reference pasted in from elsewhere. Either way this is the one
              place that says the two no longer agree. */}
          {outOfScope.length > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {outOfScope.map((entry) => entry.target.label).join(', ')}
                {outOfScope.length === 1 ? ' is' : ' are'} outside “Applies to”:{' '}
                {outOfScope[0]?.dimension === 'project'
                  ? `it needs project ${projectLabel(outOfScope[0].needs)}`
                  : outOfScope[0]?.dimension === 'machine'
                    ? `it needs machine ${machineLabel(outOfScope[0].needs)}`
                    : `it needs agent ${outOfScope[0]?.needs}`}
                . Widen the scope or remove the reference to save.
              </span>
            </div>
          ) : null}

          {brokenDependencies.length > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2 text-[11px] text-status-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {brokenDependencies.map((entry) => entry.label).join(', ')} no longer resolves. The
                Shortcut stays saved — replace or remove the reference to make it usable again.
              </span>
            </div>
          ) : null}
        </Section>

        <Section
          title="Variables"
          hint="Every !{name} in the prompt. The same name twice is one value. Never store a secret here."
        >
          {usedNames.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No variables yet. Type <code className="font-mono">{'!{name}'}</code> in the prompt to
              add one.
            </p>
          ) : (
            <div className="space-y-2">
              {usedNames.map((name) => (
                <VariableRow key={name} variable={variableFor(name)} onChange={updateVariable} />
              ))}
            </div>
          )}
          {unused.length > 0 ? (
            <p className="text-[11px] text-muted-foreground/80">
              Unused, dropped on save: {unused.map((entry) => `!{${entry.name}}`).join(', ')}
            </p>
          ) : null}
        </Section>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
        <span className="text-[11px] text-muted-foreground">
          {draft.visibility === 'workspace'
            ? 'Visible to everyone in this workspace'
            : 'Only you can see this Shortcut'}
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saveBlocked} onClick={onClose}>
            Save
          </Button>
        </div>
      </footer>
    </div>
  );
}
