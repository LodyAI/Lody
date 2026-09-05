import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useCloudQuery, usePlatformCapability } from '@lody/platform/react';
import { getServerNow, type LocalProjectId, type MachineId, type WorkspaceId } from '@lody/shared';
import {
  getShortcutMentionGate,
  type PromptShortcut,
  type PromptShortcutIndexEntry,
} from '@lody/shared/prompt-shortcuts';
import { Plus, Trash2 } from 'lucide-react';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { usePromptShortcuts } from '../../providers/prompt-shortcut-provider';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useVisibleLocalProjectsFromMachineIndex } from '@/hooks/use-visible-local-projects';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { toPersistedMentionRanges } from '@/components/mentions/mention-persistence';
import type { MentionProjectSource } from '@/components/mentions/mention-project-file-source';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
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
import {
  PromptShortcutForm,
  type ShortcutPromptEditorProps,
  type ShortcutScopeOptions,
} from './prompt-shortcut-form';

export function PromptShortcutsSetting() {
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
  const { runtime, entries, loading, pendingIds, errors, retry } = state;
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
        variables: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  };
  return (
    <div className="space-y-4 p-1">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t(
            'settings.promptShortcuts.intro',
            'Save reusable Prompts with mentions and variables. Private by default.'
          )}
        </p>
        <Button size="sm" onClick={create} disabled={!runtime || busy}>
          <Plus className="size-4" />
          {t('settings.promptShortcuts.new', 'New shortcut')}
        </Button>
      </div>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading', 'Loading…')}
        </p>
      )}
      {!loading && entries.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {t('settings.promptShortcuts.empty', 'No Prompt Shortcuts yet.')}
        </p>
      )}
      <div className="divide-y">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-3 py-3">
            <button
              type="button"
              className="min-w-0 flex-1 text-start"
              disabled={busy}
              onClick={() => void edit(entry)}
            >
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-medium">{entry.name}</span>
                <code className="text-xs text-muted-foreground">/{entry.slug}</code>
              </div>
              {entry.description && (
                <p className="truncate text-xs text-muted-foreground">{entry.description}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span>
                  {entry.visibility === 'private'
                    ? t('settings.promptShortcuts.private', 'Private')
                    : t('settings.promptShortcuts.shared', 'Workspace')}
                </span>
                {entry.scope.project && (
                  <span>
                    {entry.scope.project.kind === 'github'
                      ? entry.scope.project.repository
                      : entry.scope.project.id}
                  </span>
                )}
                {entry.scope.machineId && (
                  <span>{t('settings.promptShortcuts.machineScoped', 'Machine scoped')}</span>
                )}
                {entry.scope.providerKey && <span>{entry.scope.providerKey}</span>}
                {pendingIds.includes(entry.id) && (
                  <span>
                    {t('settings.promptShortcuts.pending', 'Saved locally · publication pending')}
                  </span>
                )}
              </div>
            </button>
            {entry.ownerUserId === runtime?.userId && (
              <Button
                size="icon"
                variant="ghost"
                disabled={busy || pendingIds.includes(entry.id)}
                onClick={() => setRemoval(entry)}
                aria-label={t('settings.promptShortcuts.delete', 'Delete shortcut')}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        ))}
      </div>
      {(error || Object.keys(errors).length > 0) && (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            {t(
              'settings.promptShortcuts.retryHelp',
              'Some changes could not be loaded or published. Your local saves are retained.'
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(false);
              retry();
            }}
          >
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      )}
      {editor && runtime && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setEditor(null);
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogTitle>
              {editor.base
                ? t('settings.promptShortcuts.edit', 'Prompt Shortcut')
                : t('settings.promptShortcuts.new', 'New shortcut')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'settings.promptShortcuts.editorHelp',
                'Save a Prompt as reusable content. Scope controls where it can be used.'
              )}
            </DialogDescription>
            {editor.value.ownerUserId !== runtime.userId ? (
              <pre className="whitespace-pre-wrap break-words text-sm">{editor.value.prompt}</pre>
            ) : (
              <ShortcutEditor
                initial={editor.value}
                canShare={runtime.canShare}
                saving={busy}
                saveBlocked={pendingIds.includes(editor.value.id)}
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
            )}
          </DialogContent>
        </Dialog>
      )}
      <AlertDialog
        open={!!removal}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.promptShortcuts.delete', 'Delete shortcut')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'settings.promptShortcuts.deleteHelp',
                'Delete this shortcut? Prompts already inserted into drafts or sent messages are unchanged.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
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
              {t('common.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ShortcutEditor(props: {
  initial: PromptShortcut;
  canShare: boolean;
  saving: boolean;
  saveBlocked: boolean;
  onCancel(): void;
  onSave(value: PromptShortcut): Promise<void>;
}) {
  const allowMachineSelection = usePlatformCapability('remoteMachines');
  const workspaceId = props.initial.workspaceId as WorkspaceId;
  const machineIndex = useVisibleMachineMetas({ workspaceId });
  const machineIds = useMemo(() => [...machineIndex.machines.keys()], [machineIndex.machines]);
  useMachineFlockAgentConfigsForMachineIds(machineIds);
  const { projects } = useVisibleLocalProjectsFromMachineIndex(machineIndex, { workspaceId });
  const configs = useAtomValue(getAllAgentConfigAtom);
  const repositories = useCloudQuery(cloudOperations.github.getWorkspaceRepositories, {
    workspaceId,
  });
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
              workspaceId,
              machineId: project.machineId as MachineId,
              localProjectId: project.id as LocalProjectId,
            }
        : undefined;
    const config = editor.scope.providerKey ? providers.get(editor.scope.providerKey) : undefined;
    return (
      <CombinedMentionTextarea
        key={JSON.stringify(editor.scope)}
        id="shortcut-prompt"
        className="min-h-48"
        value={editor.value}
        onValueChange={editor.onValueChange}
        templateScope={editor.scope}
        mentionSource={mentionSource}
        persistedMentions={editor.initialRanges}
        commandsEnabled={false}
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
        onMentionRangesChange={(ranges) => editor.onRangesChange(toPersistedMentionRanges(ranges))}
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
