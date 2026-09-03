import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { useTranslation } from 'react-i18next';
import { getServerNow, type AgentRole, type AgentRoleId, type MachineId } from '@lody/shared';

import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { useIsMobile } from '@/hooks/use-mobile';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceAgentRoleActions } from '@/hooks/use-workspace-agent-roles';
import {
  applyAgentRoleRunConfigDefaults,
  buildAgentRoleFormValue,
  buildAgentRoleFromForm,
  buildAgentRoleRunConfig,
  findAgentRoleRunConfigIssues,
  validateAgentRoleForm,
  type AgentRoleFormValue,
} from '@/lib/agent-role-form';
import { cn } from '@/lib/utils';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { AgentRoleForm } from './agent-role-form';

/**
 * A `create` carries its id from the moment the form opens.
 *
 * The id is what the name check must ignore, and a `create` becomes a catalog
 * row the instant its local write lands — while the dialog is still open. An id
 * allocated at save time would leave a window where the form finds the row it
 * just wrote and reports its own name as taken.
 */
export type AgentRoleEditorState =
  | { mode: 'add'; roleId: AgentRoleId; value: AgentRoleFormValue }
  | { mode: 'edit'; role: AgentRole; value: AgentRoleFormValue };

export const openAgentRoleEditorForCreate = (value: AgentRoleFormValue): AgentRoleEditorState => ({
  mode: 'add',
  roleId: crypto.randomUUID() as AgentRoleId,
  value,
});

export const openAgentRoleEditorForEdit = (role: AgentRole): AgentRoleEditorState => ({
  mode: 'edit',
  role,
  value: buildAgentRoleFormValue(role),
});

/**
 * The one Role editor.
 *
 * Settings and the composer's Role picker both create and edit Roles, and the
 * rules that must not be got wrong — when `revision` moves, which option keys a
 * Role may store, whether a saved value is still supported — live in
 * `lib/agent-role-form.ts` behind this single dialog rather than being wired up
 * twice.
 */
export function AgentRoleEditorDialog({
  editor,
  accessibleRoles,
  onChange,
  onClose,
  onSaved,
  source,
}: {
  editor: AgentRoleEditorState | null;
  /** Roles this user can see, for the mention-token uniqueness check. */
  accessibleRoles: readonly AgentRole[];
  onChange: (editor: AgentRoleEditorState) => void;
  onClose: () => void;
  /**
   * The Role that was just written, once it is durable. `created` separates a
   * new Role from an edit, because a surface that OPENED the create — the
   * composer — means to start using what it just made, while an edit is only an
   * edit.
   */
  onSaved?: (role: AgentRole, meta: { created: boolean }) => void;
  /** Entry point that opened the editor; used only for product analytics. */
  source: 'settings' | 'chat_landing' | 'session_composer';
}) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const isMobile = useIsMobile();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { upsert } = useWorkspaceAgentRoleActions();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const machineOptions = useMemo(
    () =>
      [...machines.values()]
        .map((machine) => ({
          machineId: machine.id,
          label: machine.name || machine.id,
          online: onlineMachineIds.has(machine.id),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [machines, onlineMachineIds]
  );

  const selectedMachineId: MachineId | null = editor?.value.machineId ?? null;
  const machineAgentConfigs = useMemo(
    () => agentConfigs.filter((config) => config.machineId === selectedMachineId),
    [agentConfigs, selectedMachineId]
  );
  const selectedAgentConfig = useMemo(
    () => machineAgentConfigs.find((config) => config.id === editor?.value.agentConfigId),
    [editor?.value.agentConfigId, machineAgentConfigs]
  );
  const selectorOptions = useAcpSelectorOptions(
    selectedAgentConfig
      ? {
          configId: selectedAgentConfig.id,
          cliType: selectedAgentConfig.cliType,
          agentType: selectedAgentConfig.agentType,
          runtimeOverrides: selectedAgentConfig.runtimeOverrides,
          machine: selectedMachineId ? (machines.get(selectedMachineId) ?? null) : null,
          // The STORED value names the model whose catalog composes the options;
          // feeding the derived defaults back in would loop.
          selectedModelId: editor?.value.modelId ?? null,
          configOptionValues: editor?.value.configOptionValues,
        }
      : undefined
  );

  // A Role pins concrete values, so as soon as an agent config's capabilities
  // are known its own defaults fill the unset fields. The user then adjusts a
  // real selection instead of accepting an "Agent default" that says nothing
  // about what would run. A stored value is never overwritten — that is what
  // keeps an incompatible one visible. Derived rather than written back: the
  // defaults are a function of the value and the capabilities, and the helper
  // returns the value itself when it changes nothing.
  const editorValue = editor
    ? selectedAgentConfig
      ? applyAgentRoleRunConfigDefaults(editor.value, selectorOptions)
      : editor.value
    : null;

  const formErrors = useMemo(
    () =>
      editorValue
        ? validateAgentRoleForm(editorValue, {
            accessibleRoles,
            editingRoleId: editor
              ? editor.mode === 'edit'
                ? editor.role.id
                : editor.roleId
              : null,
          })
        : [],
    [accessibleRoles, editor, editorValue]
  );
  const runConfigIssues = useMemo(
    () =>
      editorValue && selectedAgentConfig
        ? findAgentRoleRunConfigIssues(buildAgentRoleRunConfig(editorValue), selectorOptions)
        : [],
    [editorValue, selectedAgentConfig, selectorOptions]
  );

  const close = () => {
    setError(undefined);
    onClose();
  };

  const save = async () => {
    if (!editor || !editorValue || formErrors.length > 0 || !currentUserId) return;
    const role = buildAgentRoleFromForm(editorValue, {
      existing: editor.mode === 'edit' ? editor.role : undefined,
      ownerUserId: currentUserId,
      now: getServerNow(),
      createId: () => (editor.mode === 'add' ? editor.roleId : editor.role.id),
    });

    setSubmitting(true);
    setError(undefined);
    try {
      // Resolves on durability: the row exists, so the editor is done. The
      // upload runs on its own and is deliberately not reported — a deferred
      // upload is not a failed save and there is nothing to act on.
      await upsert(role);
      if (editor.mode === 'add') {
        capturePostHogEvent(postHog, 'settings/agent_role_created', {
          source,
          visibility: role.visibility,
          has_prompt_prefix: Boolean(role.promptPrefix),
          run_config_option_count: Object.keys(role.runConfig.configOptionValues ?? {}).length,
        });
      }
      onSaved?.(role, { created: editor.mode === 'add' });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open) close();
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
            {editor?.mode === 'edit'
              ? t('settings.agentRoles.editTitle')
              : t('settings.agentRoles.addTitle')}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {t('settings.agentRoles.dialogDescription')}
          </DialogDescription>
        </header>
        {editor && editorValue ? (
          <AgentRoleForm
            className="min-h-0 flex-1"
            value={editorValue}
            onChange={(value) => onChange({ ...editor, value })}
            machines={machineOptions}
            agentConfigs={machineAgentConfigs.map((config) => ({
              agentConfigId: config.id,
              label: config.name,
            }))}
            selectorOptions={selectedAgentConfig ? selectorOptions : null}
            issues={runConfigIssues}
            errors={formErrors}
            submitting={submitting}
            error={error}
            isEditing={editor.mode === 'edit'}
            onSubmit={() => void save()}
            onCancel={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
