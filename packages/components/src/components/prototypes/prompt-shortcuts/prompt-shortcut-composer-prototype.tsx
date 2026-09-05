/**
 * PROTOTYPE — calling a Prompt Shortcut from the composer (§5.3, §6).
 *
 * The whole interaction is here and it is real: the `/` menu filters on the
 * same eligibility resolver Settings uses, the chip is compact and owns the
 * prompt, the `!` badge counts missing required values, the send button is
 * gated on them, and "Expand and edit" compiles the snapshot into plain text
 * through the same segment pipeline that would produce the sent message.
 *
 * What is deliberately NOT here: persistence, an ACP capability cache, and any
 * attempt to nest an input inside the textarea (§2.4).
 */

import * as React from 'react';
import { ArrowUp, ChevronDown, Terminal, TriangleAlert, X, Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Mention, MentionInput, MentionLabel } from '@/ui/mention';
import {
  menuGroupLabelClassName,
  menuItemClassName,
  menuItemExtraClassName,
  menuSeparatorClassName,
  menuSeparatorStyle,
  menuSurfaceClassName,
  menuSurfaceStyle,
} from '@/ui/menu-styles';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { Textarea } from '@/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  agentLabel,
  machineLabel,
  projectLabel,
  PROTOTYPE_AGENT_COMMANDS,
  PROTOTYPE_LABELS,
  PROTOTYPE_MENTION_CATALOG,
  PROTOTYPE_SHORTCUTS,
  PROTOTYPE_WORK_CONTEXT,
} from './prompt-shortcut-fixtures';
import {
  compileShortcut,
  findMissingVariables,
  resolveEffectiveValue,
  resolveEligibility,
  resolveVariableRows,
  type PrototypeEligibility,
  type PrototypeShortcut,
  type PrototypeVariable,
  type PrototypeWorkContext,
} from './prompt-shortcut-model';
import {
  derivePrototypeRanges,
  describeEligibility,
  prototypeChipResolver,
  ScopePills,
} from './prompt-shortcut-visuals';

const COMPOSER_SHELL_CLASS_NAME = cn(
  'flex flex-col gap-2 rounded-2xl border border-foreground/[0.10] bg-background px-3 py-2.5 transition-shadow focus-within:ring-1 focus-within:ring-ring/30',
  'dark:border-input-border/70 dark:bg-input/90',
  '[--mention-chip-surface:hsl(var(--background))] dark:[--mention-chip-surface:color-mix(in_srgb,hsl(var(--input))_90%,hsl(var(--background)))]'
);

type ComposerMode = 'text' | 'invocation' | 'expanded';

export type PromptShortcutComposerPrototypeProps = {
  context?: PrototypeWorkContext;
  shortcuts?: readonly PrototypeShortcut[];
  /** Story entry point: start with this Shortcut already invoked. */
  initialSlug?: string;
  /** Story entry point: values already typed into the tray. */
  initialValues?: Record<string, string>;
  /** Story entry point: open the `/` menu with this query typed. */
  initialQuery?: string;
  /** Story entry point: start in the expanded plain-prompt state. */
  initialExpanded?: boolean;
  /** Story entry point: open the parameter surface immediately. */
  initialTrayOpen?: boolean;
  /** Touch surfaces get a bottom sheet instead of an inline tray (§5.3). */
  surface?: 'desktop' | 'mobile';
  className?: string;
};

export function PromptShortcutComposerPrototype({
  context = PROTOTYPE_WORK_CONTEXT,
  shortcuts = PROTOTYPE_SHORTCUTS,
  initialSlug,
  initialValues,
  initialQuery,
  initialExpanded = false,
  initialTrayOpen,
  surface = 'desktop',
  className,
}: PromptShortcutComposerPrototypeProps) {
  const initialShortcut = initialSlug
    ? (shortcuts.find((entry) => entry.slug === initialSlug) ?? null)
    : null;

  const [mode, setMode] = React.useState<ComposerMode>(
    initialExpanded ? 'expanded' : initialShortcut ? 'invocation' : 'text'
  );
  const [text, setText] = React.useState(initialQuery === undefined ? '' : `/${initialQuery}`);
  const [invoked, setInvoked] = React.useState<PrototypeShortcut | null>(initialShortcut);
  const [values, setValues] = React.useState<Record<string, string>>(initialValues ?? {});
  const [menuOpen, setMenuOpen] = React.useState(initialQuery !== undefined);
  const [trayOpen, setTrayOpen] = React.useState(initialTrayOpen ?? false);
  /**
   * §7 — what landed in history. `slug` is provenance captured AT SEND, not read
   * back off the live invocation: sending clears the invocation, so reading it
   * at render time lost the marker entirely.
   */
  const [sent, setSent] = React.useState<{ text: string; slug?: string } | null>(null);
  // A story may start expanded; compile the snapshot once so the box is not empty.
  const [expandedText, setExpandedText] = React.useState(() =>
    initialExpanded && initialShortcut
      ? compileShortcut(initialShortcut, PROTOTYPE_MENTION_CATALOG, initialValues ?? {}).text
      : ''
  );

  const fieldRefs = React.useRef<Array<HTMLInputElement | HTMLTextAreaElement | null>>([]);

  const entries = React.useMemo(
    () =>
      shortcuts.map((shortcut) => ({
        shortcut,
        eligibility: resolveEligibility(
          shortcut,
          PROTOTYPE_MENTION_CATALOG,
          context,
          PROTOTYPE_LABELS
        ),
      })),
    [context, shortcuts]
  );

  const query = text.startsWith('/') ? text.slice(1) : '';
  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase());

  // §2.3 — the menu shows what can run here. `unknown` is not optimistically
  // available, and an unavailable Shortcut only appears on an exact search, as
  // an unselectable line that says why.
  const availableEntries = entries.filter(
    (entry) =>
      entry.eligibility.kind === 'available' &&
      (matches(entry.shortcut.slug) || matches(entry.shortcut.name))
  );
  const diagnosticEntries =
    query.length >= 3
      ? entries.filter(
          (entry) => entry.eligibility.kind !== 'available' && entry.shortcut.slug.startsWith(query)
        )
      : [];
  const commandMatches = PROTOTYPE_AGENT_COMMANDS.filter((command) => matches(command.name));

  const variableRows = React.useMemo(
    () => (invoked ? resolveVariableRows(invoked, PROTOTYPE_MENTION_CATALOG) : []),
    [invoked]
  );
  const missing = React.useMemo(
    () => findMissingVariables(variableRows, values),
    [values, variableRows]
  );

  const invokedEntry = invoked ? entries.find((entry) => entry.shortcut.id === invoked.id) : null;
  // Re-checked here rather than trusted from selection time: switching project,
  // machine, or agent after insertion must block the send, not silently retarget.
  const invokedEligibility: PrototypeEligibility = invokedEntry?.eligibility ?? {
    kind: 'available',
  };

  const expandedMissing = React.useMemo(() => {
    if (mode !== 'expanded') return [];
    return variableRows.filter((row) => row.required && expandedText.includes(`!{${row.name}}`));
  }, [expandedText, mode, variableRows]);

  const blockedReason = (() => {
    if (mode === 'text') return text.trim().length === 0 ? 'Nothing to send' : null;
    if (invokedEligibility.kind !== 'available') return describeEligibility(invokedEligibility);
    if (mode === 'expanded') {
      return expandedMissing.length > 0
        ? `Still unfilled: ${expandedMissing.map((row) => `!{${row.name}}`).join(', ')}`
        : null;
    }
    if (missing.length > 0) {
      return `Fill ${missing.length} ${missing.length === 1 ? 'value' : 'values'} to send: ${missing
        .map((row) => row.name)
        .join(', ')}`;
    }
    return null;
  })();

  const selectShortcut = (shortcut: PrototypeShortcut) => {
    const rows = resolveVariableRows(shortcut, PROTOTYPE_MENTION_CATALOG);
    setInvoked(shortcut);
    setMode('invocation');
    setText('');
    setMenuOpen(false);
    // §5.3 — the parameter surface opens immediately and focuses the first
    // missing value, so nothing has to be discovered.
    const opens = rows.some((row) => row.required && !resolveEffectiveValue(row, values));
    setTrayOpen(opens);
    if (opens) {
      window.requestAnimationFrame(() => fieldRefs.current[0]?.focus());
    }
  };

  const clearInvocation = () => {
    setInvoked(null);
    setMode('text');
    setTrayOpen(false);
    setValues({});
  };

  const expandAndEdit = () => {
    if (!invoked) return;
    const compiled = compileShortcut(invoked, PROTOTYPE_MENTION_CATALOG, values);
    setExpandedText(compiled.text);
    setMode('expanded');
    setTrayOpen(false);
  };

  const send = () => {
    if (blockedReason) return;
    if (mode === 'expanded') {
      // Expanded text is plain text now, so it carries no Shortcut provenance.
      setSent({ text: expandedText });
      return;
    }
    if (mode === 'invocation' && invoked) {
      setSent({
        text: compileShortcut(invoked, PROTOTYPE_MENTION_CATALOG, values).text,
        slug: invoked.slug,
      });
      setInvoked(null);
      setValues({});
      setMode('text');
      setTrayOpen(false);
      return;
    }
    setSent({ text });
    setText('');
  };

  const focusNextField = (index: number) => {
    const next = fieldRefs.current[index + 1];
    if (next) next.focus();
    else setTrayOpen(false);
  };

  const expandedRanges = React.useMemo(() => derivePrototypeRanges(expandedText), [expandedText]);

  const tray = invoked ? (
    <VariableTray
      shortcut={invoked}
      rows={variableRows}
      values={values}
      onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
      onSubmitField={focusNextField}
      registerField={(index, node) => {
        fieldRefs.current[index] = node;
      }}
      onClose={() => setTrayOpen(false)}
    />
  ) : null;

  return (
    <div className={cn('flex w-full flex-col gap-3', className)}>
      {sent !== null ? (
        <SentMessagePreview text={sent.text} slug={sent.slug} onDismiss={() => setSent(null)} />
      ) : null}

      <div className="relative">
        {menuOpen && mode === 'text' ? (
          <SlashMenu
            query={query}
            available={availableEntries}
            diagnostics={diagnosticEntries}
            commands={commandMatches}
            onSelect={selectShortcut}
            onSelectCommand={(name) => {
              setText(`/${name}`);
              setMenuOpen(false);
            }}
          />
        ) : null}

        <div className={COMPOSER_SHELL_CLASS_NAME}>
          {mode === 'invocation' && invoked ? (
            <div className="flex min-h-9 flex-wrap items-center gap-2 py-0.5">
              <InvocationChip
                shortcut={invoked}
                missing={missing}
                onOpenTray={() => {
                  setTrayOpen(true);
                  window.requestAnimationFrame(() => fieldRefs.current[0]?.focus());
                }}
                onRemove={clearInvocation}
              />
              {/* §6.3 — a Shortcut chip owns the whole prompt; there is no free
                  text after it. Extra input is a variable or an expansion. */}
              <span className="text-[11px] text-muted-foreground/70">
                This Shortcut is the whole prompt
              </span>
            </div>
          ) : mode === 'expanded' ? (
            <Mention
              inputValue={expandedText}
              onInputValueChange={setExpandedText}
              mentions={expandedRanges}
              getMentionChip={prototypeChipResolver}
              triggers={[]}
              className="w-full"
            >
              <MentionLabel className="sr-only">Expanded prompt</MentionLabel>
              <MentionInput
                value={expandedText}
                rows={9}
                className="resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              />
            </Mention>
          ) : (
            <Textarea
              value={text}
              rows={3}
              placeholder="Ask anything, or press / for commands"
              className="resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              onChange={(event) => {
                const next = event.target.value;
                setText(next);
                setMenuOpen(next.startsWith('/'));
              }}
            />
          )}

          {mode === 'invocation' && trayOpen && surface === 'desktop' ? tray : null}

          <div className="flex items-center justify-between gap-2 pt-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <ContextPill label={projectLabel(context.projectId ?? '')} />
              <ContextPill label={machineLabel(context.machineId ?? '')} />
              <ContextPill label={agentLabel(context.agentId ?? '')} />
              {mode === 'invocation' && invoked ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground"
                  onClick={expandAndEdit}
                >
                  Expand and edit
                </Button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {blockedReason && mode !== 'text' ? (
                <span className="max-w-[280px] truncate text-[11px] text-status-warning">
                  {blockedReason}
                </span>
              ) : null}
              <Button
                type="button"
                size="icon"
                className="size-8 rounded-full"
                aria-label="Send"
                disabled={Boolean(blockedReason)}
                onClick={send}
              >
                <ArrowUp className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {mode === 'expanded' ? (
        <p className="text-[11px] text-muted-foreground">
          Expanded from <span className="font-mono">/{invoked?.slug}</span>. It is plain text now —
          editing it no longer follows the Shortcut.
        </p>
      ) : null}

      {surface === 'mobile' ? (
        <Sheet open={trayOpen && mode === 'invocation'} onOpenChange={(open) => setTrayOpen(open)}>
          <SheetContent side="bottom" className="rounded-t-2xl p-4">
            <SheetTitle className="text-sm">
              {invoked ? `/${invoked.slug}` : 'Shortcut values'}
            </SheetTitle>
            <SheetDescription className="text-[11px]">
              {missing.length > 0
                ? `${missing.length} required ${missing.length === 1 ? 'value' : 'values'} missing`
                : 'All values filled'}
            </SheetDescription>
            <div className="mt-3">{tray}</div>
            <Button
              type="button"
              className="mt-3 w-full"
              size="sm"
              onClick={() => setTrayOpen(false)}
            >
              Done
            </Button>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function ContextPill({ label }: { label: string }) {
  if (!label) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-border/60 px-2 py-0.5 text-[11px] leading-4 text-muted-foreground">
      {label}
    </span>
  );
}

/**
 * §6.3 — the compact invocation. A `/slug` chip plus, when values are missing,
 * a `!` that carries the count. The `!` is a STATE, not the input mechanism:
 * clicking it opens the parameter surface.
 */
function InvocationChip({
  shortcut,
  missing,
  onOpenTray,
  onRemove,
}: {
  shortcut: PrototypeShortcut;
  missing: readonly PrototypeVariable[];
  onOpenTray: () => void;
  onRemove: () => void;
}) {
  const chip = (
    <button
      type="button"
      onClick={onOpenTray}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-sm transition-colors',
        missing.length > 0
          ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
          : 'border-border/70 bg-foreground/[0.04] text-foreground'
      )}
    >
      <Zap className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="font-mono text-[13px]">/{shortcut.slug}</span>
      {missing.length > 0 ? (
        <span className="ms-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-status-warning/25 px-1 text-[11px] font-semibold tabular-nums">
          !{missing.length}
        </span>
      ) : null}
    </button>
  );

  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>
          {missing.length > 0
            ? `Missing: ${missing.map((row) => row.label ?? row.name).join(', ')}`
            : shortcut.name}
        </TooltipContent>
      </Tooltip>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6 text-muted-foreground"
        aria-label={`Remove /${shortcut.slug}`}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </span>
  );
}

/** The parameter surface. Inline under the composer on desktop, in a sheet on touch. */
function VariableTray({
  shortcut,
  rows,
  values,
  onChange,
  onSubmitField,
  registerField,
  onClose,
}: {
  shortcut: PrototypeShortcut;
  rows: readonly PrototypeVariable[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onSubmitField: (index: number) => void;
  registerField: (index: number, node: HTMLInputElement | HTMLTextAreaElement | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 p-2.5">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          Values for <span className="font-mono">/{shortcut.slug}</span>
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-muted-foreground"
          aria-label="Close values"
          onClick={onClose}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => {
          const value = values[row.name] ?? row.defaultValue ?? '';
          const missing = row.required && value.length === 0;
          return (
            <div key={row.name} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <label
                  htmlFor={`prototype-var-${row.name}`}
                  className="text-[11px] font-medium text-foreground"
                >
                  {row.label ?? row.name}
                </label>
                <code className="font-mono text-[10px] text-muted-foreground">{`!{${row.name}}`}</code>
                {row.required ? null : (
                  <span className="text-[10px] text-muted-foreground/70">optional</span>
                )}
                {missing ? (
                  <TriangleAlert className="size-3 text-status-warning" aria-hidden="true" />
                ) : null}
              </div>
              {row.multiline ? (
                <Textarea
                  id={`prototype-var-${row.name}`}
                  ref={(node) => registerField(index, node)}
                  value={value}
                  rows={2}
                  className="min-h-0 resize-none text-xs"
                  onChange={(event) => onChange(row.name, event.target.value)}
                />
              ) : (
                <Input
                  id={`prototype-var-${row.name}`}
                  ref={(node) => registerField(index, node)}
                  value={value}
                  className="h-7 text-xs"
                  onChange={(event) => onChange(row.name, event.target.value)}
                  onKeyDown={(event) => {
                    // Enter advances between single-line fields; the last one
                    // returns to the composer.
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onSubmitField(index);
                    }
                  }}
                />
              )}
              {row.description ? (
                <p className="text-[10px] text-muted-foreground">{row.description}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** §6.1 — one menu, two sources, each labelled. A Shortcut never pretends to be an ACP command. */
function SlashMenu({
  query,
  available,
  diagnostics,
  commands,
  onSelect,
  onSelectCommand,
}: {
  query: string;
  available: ReadonlyArray<{ shortcut: PrototypeShortcut; eligibility: PrototypeEligibility }>;
  diagnostics: ReadonlyArray<{ shortcut: PrototypeShortcut; eligibility: PrototypeEligibility }>;
  commands: ReadonlyArray<{ name: string; description: string }>;
  onSelect: (shortcut: PrototypeShortcut) => void;
  onSelectCommand: (name: string) => void;
}) {
  const empty = available.length === 0 && diagnostics.length === 0 && commands.length === 0;
  return (
    <div
      className={cn(menuSurfaceClassName, 'absolute bottom-full left-0 z-30 mb-2 w-[420px]')}
      style={menuSurfaceStyle}
      role="listbox"
      aria-label="Slash commands"
    >
      {available.length > 0 || diagnostics.length > 0 ? (
        <div className={menuGroupLabelClassName}>Prompt Shortcuts</div>
      ) : null}
      {available.map((entry) => (
        <button
          key={entry.shortcut.id}
          type="button"
          className={cn(menuItemClassName, 'text-left')}
          onClick={() => onSelect(entry.shortcut)}
        >
          <Zap className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="font-mono text-[13px]">/{entry.shortcut.slug}</span>
            {entry.shortcut.description ? (
              <span className="ms-2 text-xs text-muted-foreground">
                {entry.shortcut.description}
              </span>
            ) : null}
          </span>
        </button>
      ))}
      {/* §2.3 — an exact search for something unavailable explains itself
          instead of letting the Shortcut look deleted. Not selectable. */}
      {diagnostics.map((entry) => (
        <div
          key={entry.shortcut.id}
          className={cn(menuItemClassName, 'cursor-not-allowed opacity-60')}
          aria-disabled="true"
        >
          <Zap className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 font-mono text-[13px]">/{entry.shortcut.slug}</span>
          <span className={cn(menuItemExtraClassName, 'text-status-warning')}>
            {describeEligibility(entry.eligibility)}
          </span>
        </div>
      ))}

      {commands.length > 0 ? (
        <>
          {available.length > 0 || diagnostics.length > 0 ? (
            <div className={menuSeparatorClassName} style={menuSeparatorStyle} />
          ) : null}
          <div className={menuGroupLabelClassName}>Agent Commands</div>
          {commands.map((command) => (
            <button
              key={command.name}
              type="button"
              className={cn(menuItemClassName, 'text-left')}
              onClick={() => onSelectCommand(command.name)}
            >
              <Terminal className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="font-mono text-[13px]">/{command.name}</span>
                <span className="ms-2 text-xs text-muted-foreground">{command.description}</span>
              </span>
            </button>
          ))}
        </>
      ) : null}

      {empty ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          No Shortcut or command matches “{query}”.
        </div>
      ) : null}
    </div>
  );
}

/**
 * §7 — what actually lands in history: the fully expanded Prompt. The `From
 * /slug` marker is provenance, never something a replay depends on.
 */
function SentMessagePreview({
  text,
  slug,
  onDismiss,
}: {
  text: string;
  slug?: string;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-3">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Sent message</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-6 text-muted-foreground"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <pre className="whitespace-pre-wrap break-words font-sans text-xs text-foreground">
        {text}
      </pre>
      {slug ? <p className="mt-2 text-[11px] text-muted-foreground/80">From /{slug}</p> : null}
    </div>
  );
}

/** Small helper the desktop story uses to explain what the pills mean. */
export function PromptShortcutContextSummary({
  context = PROTOTYPE_WORK_CONTEXT,
  shortcut,
}: {
  context?: PrototypeWorkContext;
  shortcut: PrototypeShortcut;
}) {
  const eligibility = resolveEligibility(
    shortcut,
    PROTOTYPE_MENTION_CATALOG,
    context,
    PROTOTYPE_LABELS
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ScopePills scope={shortcut.scope} />
      <span className="text-[11px] text-muted-foreground">{describeEligibility(eligibility)}</span>
    </div>
  );
}
