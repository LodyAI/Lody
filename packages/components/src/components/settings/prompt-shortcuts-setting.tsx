import React, { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useCloudQuery, usePlatformCapability } from '@lody/platform/react';
import { getServerNow, type LocalProjectId, type MachineId, type WorkspaceId } from '@lody/shared';
import {
  getShortcutEmoji,
  getShortcutMentionGate,
  getShortcutMentionScopeIssues,
  type PromptShortcut,
  type PromptShortcutIndexEntry,
} from '@lody/shared/prompt-shortcuts';
import { Loader2, Plus, SquareSlash, Trash2 } from 'lucide-react';
import { promptShortcutsFeatureEnabledAtom } from '@/atoms/settings';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { cn } from '@/lib/utils';
import { usePromptShortcuts } from '../../providers/prompt-shortcut-provider';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { getComposerMentionChip } from '@/components/mentions/mention-chips';
import { toPersistedMentionRanges } from '@/components/mentions/mention-persistence';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { settingContainerClass } from '.';
import { FormMessage, Section } from './form-primitives';
import {
  PromptShortcutForm,
  type ShortcutPromptEditorProps,
  type ShortcutScopeOptions,
} from './prompt-shortcut-form';
import { ScopePills } from './prompt-shortcut-scope';

export function PromptShortcutsSetting() {
  const enabled = useAtomValue(promptShortcutsFeatureEnabledAtom);
  const { t } = useTranslation();
  if (!enabled)
    return (
      <p className={settingContainerClass} role="status">
        {t(
          'settings.promptShortcuts.disabled',
          'Enable Prompt Shortcuts under Developer mode in Settings → About to use this feature.'
        )}
      </p>
    );
  return <EnabledPromptShortcutsSetting />;
}

function EnabledPromptShortcutsSetting() {
  const state = usePromptShortcuts();
  return (
    <PromptShortcutsSettingContent
      key={
        state.runtime
          ? JSON.stringify([state.runtime.workspaceId, state.runtime.userId])
          : 'unavailable'
      }
      state={state}
    />
  );
}

/** Drafts and late async reads must not survive an account/workspace switch. */
function PromptShortcutsSettingContent({
  state,
}: {
  state: ReturnType<typeof usePromptShortcuts>;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { runtime, entries, loading, errors, retry } = state;
  const scope = useShortcutScopeOptions(runtime?.workspaceId);
  const [editor, setEditor] = useState<{
    value: PromptShortcut;
    base: PromptShortcutIndexEntry | null;
  } | null>(null);
  const [removal, setRemoval] = useState<PromptShortcutIndexEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const edit = async (entry: PromptShortcutIndexEntry) => {
    if (!runtime) return;
    setBusy(true);
    setError(false);
    try {
      setEditor({ value: await runtime.read(entry), base: entry });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const create = () => {
    if (!runtime) return;
    const now = getServerNow();
    setEditor({
      base: null,
      value: {
        v: 1,
        id: crypto.randomUUID(),
        revision: crypto.randomUUID(),
        workspaceId: runtime.workspaceId,
        ownerUserId: runtime.userId,
        visibility: 'private',
        name: '',
        slug: '',
        prompt: '',
        scope: {},
        mentions: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  };
  const owned = editor ? editor.value.ownerUserId === runtime?.userId : false;
  return (
    <div className={settingContainerClass}>
      <p className="text-xs leading-snug text-muted-foreground">
        {t(
          'settings.promptShortcuts.intro',
          'Saved Prompts you can call with a slash command. Each one says where it applies; a Shortcut with nothing set works anywhere in this workspace. Private until you share it.'
        )}
      </p>

      <PromptShortcutsList
        entries={entries}
        options={scope.options}
        currentUserId={runtime?.userId ?? null}
        loading={loading}
        busy={busy}
        canCreate={!!runtime}
        onCreate={create}
        onOpen={(entry) => void edit(entry)}
        onDelete={setRemoval}
      />

      {(error || Object.keys(errors).length > 0) && (
        <FormMessage tone="warning">
          <span className="block">
            {t(
              'settings.promptShortcuts.retryHelp',
              'Some changes could not be loaded or published. Your local saves are kept, and you can keep editing.'
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-7 text-xs"
            onClick={() => {
              setError(false);
              retry();
            }}
          >
            {t('common.retry', 'Retry')}
          </Button>
        </FormMessage>
      )}

      <Dialog
        open={!!editor && !!runtime}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
        }}
      >
        <DialogContent
          overlayClassName={
            // Desktop settings is itself a dialog; match its z-index so this
            // later overlay covers it without stacking a second /80 veil.
            isMobile ? undefined : 'z-[var(--z-dialog)] bg-black/20'
          }
          className={cn(
            'flex max-h-[min(680px,88dvh)] w-[min(620px,96dvw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none sm:p-0',
            !isMobile && 'shadow-popover'
          )}
        >
          <header className="shrink-0 border-b border-border/60 px-5 py-3 pr-12">
            <DialogTitle className="text-sm font-semibold">
              {!editor?.base
                ? t('settings.promptShortcuts.new', 'New Prompt Shortcut')
                : owned
                  ? t('settings.promptShortcuts.edit', 'Edit Prompt Shortcut')
                  : t('settings.promptShortcuts.view', 'Prompt Shortcut')}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {owned
                ? t(
                    'settings.promptShortcuts.editorHelp',
                    'Saved to this workspace and sent as one message.'
                  )
                : t(
                    'settings.promptShortcuts.readOnlyHelp',
                    'Shared by another member. Only its author can change it.'
                  )}
            </DialogDescription>
          </header>
          {editor && runtime ? (
            owned ? (
              <ShortcutEditor
                key={editor.value.id}
                className="min-h-0 flex-1"
                initial={editor.value}
                isNew={!editor.base}
                canShare={runtime.canShare}
                saving={busy}
                scope={scope}
                onCancel={() => setEditor(null)}
                onSave={async (value) => {
                  setBusy(true);
                  try {
                    await runtime.save({
                      value: { ...value, revision: crypto.randomUUID(), updatedAt: getServerNow() },
                      base: editor.base,
                      bodyDocId:
                        !editor.base || editor.base.visibility !== value.visibility
                          ? crypto.randomUUID()
                          : editor.base.bodyDocId,
                    });
                    setEditor(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            ) : (
              <PromptShortcutReadOnlyView
                className="min-h-0 flex-1"
                shortcut={editor.value}
                options={scope.options}
                onClose={() => setEditor(null)}
              />
            )
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!removal}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.promptShortcuts.deleteTitle', 'Delete Prompt Shortcut')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.promptShortcuts.deleteHelp', {
                defaultValue:
                  'Delete “{{name}}”? Prompts already inserted into drafts or sent messages are unchanged.',
                name: removal?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                if (!runtime || !removal) return;
                setBusy(true);
                void runtime
                  .remove(removal)
                  .then(() => setRemoval(null))
                  .catch(() => setError(true))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('common.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The catalog, including the Shortcuts that cannot run right now.
 *
 * Settings is where a Shortcut gets FIXED, so a row that vanishes when its
 * machine sleeps is a row nobody can repair — unlike the `/` menu, which shows
 * only what the current chat can actually call.
 */
export function PromptShortcutsList({
  entries,
  options,
  currentUserId,
  loading,
  busy,
  canCreate,
  onCreate,
  onOpen,
  onDelete,
}: {
  entries: readonly PromptShortcutIndexEntry[];
  options?: ShortcutScopeOptions;
  currentUserId: string | null;
  loading: boolean;
  busy: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onOpen: (entry: PromptShortcutIndexEntry) => void;
  onDelete: (entry: PromptShortcutIndexEntry) => void;
}) {
  const { t } = useTranslation();
  const addLabel = t('settings.promptShortcuts.new', 'New Prompt Shortcut');
  return (
    <section className="flex flex-col">
      <div className="flex items-center justify-between gap-2 pb-1 pt-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            {t('settings.tabs.promptShortcuts', 'Prompt Shortcuts')}
          </h3>
          {entries.length > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground/70">{entries.length}</span>
          ) : null}
          {loading ? (
            <span
              role="status"
              className="flex items-center gap-1 text-[11px] text-muted-foreground/70"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('common.loading', 'Loading…')}
            </span>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              aria-label={addLabel}
              disabled={!canCreate || busy}
              onClick={onCreate}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{addLabel}</TooltipContent>
        </Tooltip>
      </div>

      {entries.length === 0 ? (
        loading ? null : (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-6 py-8 text-center text-sm">
            <SquareSlash className="h-6 w-6 text-muted-foreground/70" aria-hidden="true" />
            <p className="mt-2 text-muted-foreground">
              {t(
                'settings.promptShortcuts.empty',
                'No Prompt Shortcuts yet. Save a Prompt you retype often and call it with /.'
              )}
            </p>
            <Button size="sm" className="mt-3" disabled={!canCreate || busy} onClick={onCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {addLabel}
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <PromptShortcutRow
              key={entry.id}
              entry={entry}
              options={options}
              canManage={entry.ownerUserId === currentUserId}
              busy={busy}
              onOpen={() => onOpen(entry)}
              onDelete={() => onDelete(entry)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One catalog row.
 *
 * States what the author decided — the command, who can read it, where it
 * applies, how many values a caller has to fill in — and, separately, anything
 * that stops it working. Scope pills are the author's intent; the status line
 * below them is a fact about right now, and the two never merge.
 */
export function PromptShortcutRow({
  entry,
  options,
  canManage,
  busy,
  onOpen,
  onDelete,
}: {
  entry: PromptShortcutIndexEntry;
  options?: ShortcutScopeOptions;
  canManage: boolean;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  // Derived from the index alone: the saved dependencies against the saved
  // scope. It is not live availability — that needs the machine and the body —
  // so the row says what to repair rather than claiming a Shortcut is ready.
  const outOfScope = entry.dependencySummary.some(
    (target) => getShortcutMentionScopeIssues(entry.scope, target).length > 0
  );
  return (
    <div className="overflow-hidden rounded-lg bg-foreground/[0.04]">
      <div className="flex w-full min-w-0 items-center transition-colors hover:bg-hover/40">
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          aria-label={canManage ? t('common.edit', 'Edit') : t('common.view', 'View')}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-3 py-2.5 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-sm leading-none"
          >
            {getShortcutEmoji(entry)}
          </span>
          {/* Two columns, not one stack: identity reads down the left, and what
              the author set plus what is happening to it sit against the right
              edge. Both halves wrap instead of relying on a viewport breakpoint —
              settings render in a panel far narrower than the window. */}
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-sm font-medium leading-tight">
                {entry.name}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                /{entry.slug}
              </span>
              {/* Visibility, not scope: the pills say where it can be called,
                  this says who can read it. */}
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                {entry.visibility === 'workspace'
                  ? t('settings.promptShortcuts.shared', 'Shared')
                  : t('settings.promptShortcuts.private', 'Private')}
              </Badge>
              {/* Owned by someone else: the missing delete button is the only
                  other sign, and an absence is not a signal. */}
              {canManage ? null : (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
                  {t('settings.promptShortcuts.readOnly', 'Read-only')}
                </Badge>
              )}
              <span className="ms-auto shrink-0">
                <ScopePills scope={entry.scope} options={options} />
              </span>
            </span>
            {entry.description || outOfScope ? (
              <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                {entry.description ? (
                  <span className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground">
                    {entry.description}
                  </span>
                ) : null}
                {/* The one status worth a row: the Shortcut's own references no
                    longer fit the scope it was saved with, which only its author
                    can repair. Publication state is deliberately absent — a local
                    save is already durable and the runtime retries on its own. */}
                {outOfScope ? (
                  <span className="ms-auto shrink-0 text-[11px] leading-tight text-status-warning">
                    {t(
                      'settings.promptShortcuts.needsAttention',
                      'A reference is outside this scope'
                    )}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1 self-start py-2 pl-2 pr-2">
          {canManage ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              aria-label={t('settings.promptShortcuts.delete', 'Delete shortcut')}
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Someone else's shared Shortcut.
 *
 * Read-only because only its author may change it (a copy-to-mine action is not
 * built yet). Rendered with the editor's own sections so the same Shortcut looks
 * like the same thing whether or not you own it.
 */
export function PromptShortcutReadOnlyView({
  shortcut,
  options,
  onClose,
  className,
}: {
  shortcut: PromptShortcut;
  options?: ShortcutScopeOptions;
  onClose: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="scrollbar-pro min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden="true" className="text-sm leading-none">
            {getShortcutEmoji(shortcut)}
          </span>
          <span className="min-w-0 truncate text-sm font-medium">{shortcut.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">/{shortcut.slug}</span>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {t('settings.promptShortcuts.shared', 'Shared')}
          </Badge>
        </div>
        {shortcut.description ? (
          <p className="text-xs leading-snug text-muted-foreground">{shortcut.description}</p>
        ) : null}
        <Section title={t('settings.promptShortcuts.scope', 'Applies to')}>
          <ScopePills scope={shortcut.scope} options={options} />
        </Section>
        <Section title={t('settings.promptShortcuts.prompt', 'Prompt')}>
          {/* Same type as the editor's own prompt field: one Shortcut should not
              look like two different things depending on who opened it. */}
          <div className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/60 p-2.5 text-sm leading-6">
            {shortcut.prompt}
          </div>
        </Section>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          {t('common.close', 'Close')}
        </Button>
      </footer>
    </div>
  );
}

/**
 * Everything the scope axes can be set to, resolved once for the whole panel.
 *
 * The list needs the same labels as the editor's selectors — a row that printed
 * a raw machine id next to a selector that prints its name is two different
 * answers to one question.
 */
function useShortcutScopeOptions(workspaceIdInput?: string) {
  const workspaceId = workspaceIdInput as WorkspaceId | undefined;
  const machineIndex = useVisibleMachineMetas(workspaceId ? { workspaceId } : undefined);
  const machineIds = useMemo(() => [...machineIndex.machines.keys()], [machineIndex.machines]);
  useMachineFlockAgentConfigsForMachineIds(machineIds);
  const { projects } = useVisibleLocalProjectsFromMachineIndex(
    machineIndex,
    workspaceId ? { workspaceId } : undefined
  );
  const configs = useAtomValue(getAllAgentConfigAtom);
  const repositories = useCloudQuery(
    cloudOperations.github.getWorkspaceRepositories,
    workspaceId ? { workspaceId } : 'skip'
  );
  const providers = useMemo(
    () =>
      new Map(
        configs
          .filter((config) => machineIndex.machines.has(config.machineId))
          .map((config) => [`${config.cliType}:${config.agentType}`, config])
      ),
    [configs, machineIndex.machines]
  );
  const options: ShortcutScopeOptions = {
    projects: [
      ...(repositories ?? []).map((repo) => ({
        value: { kind: 'github' as const, repository: repo.fullName },
        label: repo.fullName,
      })),
      ...[...projects.values()].map(({ project, machine }) => ({
        value: { kind: 'local' as const, id: project.id, machineId: machine.id },
        label: `${project.name} · ${machine.name}`,
      })),
    ],
    machines: [...machineIndex.machines.values()].map((machine) => ({
      value: machine.id,
      label: machine.name,
    })),
    providers: [...providers].map(([value, config]) => ({ value, label: config.name })),
  };
  return { options, providers, repositories, workspaceId };
}

type ShortcutScopeData = ReturnType<typeof useShortcutScopeOptions>;

/**
 * The editor, wired to this workspace's mention sources.
 *
 * The prompt field is the composer's own mention textarea in template mode:
 * `@` / `$` / `#` complete from what "Applies to" allows, and the semantic
 * target is frozen at selection instead of re-parsed from a label at save time.
 */
function ShortcutEditor({
  scope,
  ...props
}: {
  initial: PromptShortcut;
  isNew: boolean;
  canShare: boolean;
  saving: boolean;
  scope: ShortcutScopeData;
  className?: string;
  onCancel(): void;
  onSave(value: PromptShortcut): Promise<void>;
}) {
  const allowMachineSelection = usePlatformCapability('remoteMachines');
  const { options, providers, repositories, workspaceId } = scope;
  const renderPrompt = (editor: ShortcutPromptEditorProps) => {
    const { project } = editor.scope;
    const mentionSource: MentionProjectSource | undefined =
      getShortcutMentionGate('file', editor.scope).enabled && project
        ? project.kind === 'github'
          ? {
              kind: 'github',
              repoFullName: project.repository,
              isPublic:
                repositories?.find((repo) => repo.fullName === project.repository)?.private ===
                false,
            }
          : {
              kind: 'local',
              workspaceId: workspaceId as WorkspaceId,
              machineId: project.machineId as MachineId,
              localProjectId: project.id as LocalProjectId,
            }
        : undefined;
    const config = editor.scope.providerKey ? providers.get(editor.scope.providerKey) : undefined;
    return (
      <ShortcutPromptField
        editor={editor}
        mentionSource={mentionSource}
        disabled={props.saving}
        skillAgent={
          config
            ? {
                cliType: config.cliType,
                agentType: config.agentType,
                machineId: editor.scope.machineId,
              }
            : undefined
        }
      />
    );
  };
  return (
    <PromptShortcutForm
      {...props}
      allowMachineSelection={allowMachineSelection}
      options={options}
      renderPrompt={renderPrompt}
    />
  );
}

/** Kept in step with the composer's box: border, radius, chip cover colour. */
const SHORTCUT_PROMPT_SURFACE_CLASS_NAME = cn(
  'w-full rounded-xl border border-foreground/[0.10] bg-background px-3 py-2.5',
  'focus-within:outline-hidden focus-within:ring-1 focus-within:ring-ring/30',
  'dark:border-input-border/70 dark:bg-input/90',
  '[--mention-chip-surface:hsl(var(--background))] dark:[--mention-chip-surface:color-mix(in_srgb,hsl(var(--input))_90%,hsl(var(--background)))]'
);

/**
 * The prompt field: the composer's own mention textarea, in template mode.
 *
 * Exported so Storybook renders the field that ships rather than a plain
 * textarea — the chip cover colour has to match the surface behind it, and that
 * is only visible in the real thing.
 */
export function ShortcutPromptField({
  editor,
  mentionSource,
  skillAgent,
  disabled,
}: {
  editor: ShortcutPromptEditorProps;
  mentionSource?: MentionProjectSource;
  skillAgent?: React.ComponentProps<typeof CombinedMentionTextarea>['skillAgent'];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <CombinedMentionTextarea
      // Scope owns the candidate sources, so a change rebuilds them; the draft's
      // own ranges come back through `persistedMentions`.
      key={JSON.stringify(editor.scope)}
      id="shortcut-prompt"
      aria-label={t('settings.promptShortcuts.prompt', 'Prompt')}
      placeholder={t(
        'settings.promptShortcuts.promptPlaceholder',
        'Write the prompt you would otherwise retype.'
      )}
      value={editor.value}
      onValueChange={editor.onValueChange}
      templateScope={editor.scope}
      mentionSource={mentionSource}
      persistedMentions={editor.initialRanges}
      getMentionChip={getComposerMentionChip}
      commandsEnabled={false}
      disabled={disabled}
      rows={4}
      // The composer's own surface: the field where a template is written and
      // the field where a message is written are the same kind of field.
      containerClassName={SHORTCUT_PROMPT_SURFACE_CLASS_NAME}
      className="input-scrollbar min-h-28 resize-none border-transparent bg-transparent px-0 py-0 text-sm leading-6 text-input-foreground placeholder:text-input-placeholder focus-visible:ring-0 focus-visible:ring-offset-0"
      skillAgent={skillAgent}
      onMentionRangesChange={(ranges) => editor.onRangesChange(toPersistedMentionRanges(ranges))}
    />
  );
}
