import { RoleMemoryPicker } from './memory-setting';
import { useEffect, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Plus } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { useTranslation } from 'react-i18next';
import {
  getServerNow,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleId,
  type MachineId,
} from '@lody/shared';

import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { buildAcpSelectorOptions } from '@/components/shared/acp-selector-options';
import { useAcpSelectorOptions } from '@/hooks/use-acp-selector-options';
import { useDialogExitSnapshot } from '@/hooks/use-dialog-exit-snapshot';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { useWorkspaceAgentRoleActions } from '@/hooks/use-workspace-agent-roles';
import {
  applyAgentRoleRunConfigDefaults,
  getAgentRoleFormTarget,
  putAgentRoleFormTarget,
  suggestAgentRoleTarget,
  type AgentRoleTargetFormValue,
  buildAgentRoleFormValue,
  buildAgentRoleFromForm,
  buildAgentRoleRunConfig,
  carryAgentRoleOptionsToModel,
  findAgentRoleRunConfigIssues,
  validateAgentRoleForm,
  type AgentRoleFormValue,
} from '@/lib/agent-role-form';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { Tabs } from '@lody/ui/tabs';
import { Button } from '@lody/ui/button';
import { useMemoryAssociations } from '@/hooks/use-memory-associations';
import { Dialog } from '@/ui/dialog';
import { AgentRoleForm } from './agent-role-form';
import { useSettingsPane } from './settings-page-header';
import {
  SETTINGS_EDITOR_DIALOG_LAYOUT,
  SETTINGS_EDITOR_DIALOG_WIDTH,
  settingsCatalog as catalog,
} from './surface';

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

export const openAgentRoleEditorForEdit = (
  role: AgentRole,
  activeMachineId?: MachineId
): AgentRoleEditorState => ({
  mode: 'edit',
  role,
  value: buildAgentRoleFormValue(role, activeMachineId),
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
  editor: openEditor,
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
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { upsert } = useWorkspaceAgentRoleActions();
  const settingsPane = useSettingsPane();
  // Everything below renders the editor the dialog was open with, so a closing
  // panel fades out with its form rather than emptying first.
  const { shown: editor, onOpenChangeComplete } = useDialogExitSnapshot(openEditor);

  const [tab, setTab] = useState<'configuration' | 'team'>('configuration');
  const editorId = openEditor?.mode === 'edit' ? openEditor.role.id : openEditor?.roleId;
  useEffect(() => {
    setTab('configuration');
  }, [editorId]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const targetMachineIds = editor?.value.targets.map((target) => target.machineId) ?? [];
  const targetMachineKey = targetMachineIds.join('\0');
  // The Role's own machines lead, in authoring order, then every other machine
  // it could be added to. A target on a machine this user cannot see stays as a
  // tab so it is never dropped from the Role by saving.
  const machineOptions = useMemo(() => {
    const own = targetMachineKey ? (targetMachineKey.split('\0') as MachineId[]) : [];
    const option = (machineId: MachineId) => {
      const machine = machines.get(machineId);
      return {
        machineId,
        label: machine?.name || (machine ? machineId : t('settings.agentRoles.unknownMachine')),
        online: onlineMachineIds.has(machineId),
      };
    };
    const others = [...machines.keys()]
      .filter((machineId) => !own.includes(machineId))
      .map(option)
      .sort(
        (left, right) =>
          Number(right.online) - Number(left.online) || left.label.localeCompare(right.label)
      );
    return [...own.map(option), ...others];
  }, [machines, onlineMachineIds, t, targetMachineKey]);

  const activeMachineId: MachineId | null = editor?.value.activeMachineId ?? null;
  const activeTarget = editor ? getAgentRoleFormTarget(editor.value) : undefined;
  const machineAgentConfigs = useMemo(
    () => agentConfigs.filter((config) => config.machineId === activeMachineId),
    [agentConfigs, activeMachineId]
  );
  const selectedAgentConfig = useMemo(
    () => machineAgentConfigs.find((config) => config.id === activeTarget?.agentConfigId),
    [activeTarget?.agentConfigId, machineAgentConfigs]
  );
  const selectorTarget = selectedAgentConfig
    ? {
        configId: selectedAgentConfig.id,
        cliType: selectedAgentConfig.cliType,
        agentType: selectedAgentConfig.agentType,
        runtimeOverrides: selectedAgentConfig.runtimeOverrides,
        machine: activeMachineId ? (machines.get(activeMachineId) ?? null) : null,
      }
    : undefined;
  const selectorOptions = useAcpSelectorOptions(
    selectorTarget && {
      ...selectorTarget,
      // A Role pins its model: the effort ladder must follow the model
      // being edited, not the probe-time current one, so the picker and
      // the compatibility check agree on the same ladder.
      selectedModelId: activeTarget?.modelId ?? null,
    }
  );

  // A Role pins concrete values, so as soon as an agent config's capabilities
  // are known its own defaults fill the unset fields of the target being
  // edited. The user then adjusts a real selection instead of accepting an
  // "Agent default" that says nothing about what would run. A stored value is
  // never overwritten — that is what keeps an incompatible one visible.
  // Derived rather than written back: the defaults are a function of the value
  // and the capabilities, and the helper returns the value itself when it
  // changes nothing.
  const editorValue = editor
    ? activeTarget && selectedAgentConfig
      ? putAgentRoleFormTarget(
          editor.value,
          applyAgentRoleRunConfigDefaults(activeTarget, selectorOptions)
        )
      : editor.value
    : null;
  const editorTarget = editorValue ? getAgentRoleFormTarget(editorValue) : undefined;

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
      editorTarget && selectedAgentConfig
        ? findAgentRoleRunConfigIssues(buildAgentRoleRunConfig(editorTarget), selectorOptions)
        : [],
    [editorTarget, selectedAgentConfig, selectorOptions]
  );

  // What "Add to this machine" starts from: the first target with an agent.
  const sourceTarget = editorValue?.targets.find((target) => target.agentConfigId);
  const sourceConfig = agentConfigs.find((config) => config.id === sourceTarget?.agentConfigId);

  const close = () => {
    setError(undefined);
    onClose();
  };

  const save = async () => {
    if (!openEditor || !editor || !editorValue || formErrors.length > 0 || !currentUserId) return;
    const role = buildAgentRoleFromForm(editorValue, {
      existing: editor.mode === 'edit' ? editor.role : undefined,
      ownerUserId: currentUserId,
      now: getServerNow(),
      createId: () => (editor.mode === 'add' ? editor.roleId : editor.role.id),
      selectorOptions: selectedAgentConfig ? selectorOptions : null,
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
          machine_target_count: 1 + (role.additionalTargets?.length ?? 0),
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
    <Dialog.Root
      open={openEditor !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog.Content
        width={SETTINGS_EDITOR_DIALOG_WIDTH}
        centerOn={settingsPane}
        className={SETTINGS_EDITOR_DIALOG_LAYOUT}
        style={{ height: 'min(680px, 88dvh)' }}
      >
        <Dialog.Header>
          <Dialog.Title>
            {editor?.mode === 'edit'
              ? t('settings.agentRoles.editTitle')
              : t('settings.agentRoles.addTitle')}
          </Dialog.Title>
          <Dialog.Description>{t('settings.agentRoles.dialogDescription')}</Dialog.Description>
        </Dialog.Header>
        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as 'configuration' | 'team')}>
          <Tabs.List>
            <Tabs.Tab value="configuration">{t('settings.agentRoles.configurationTab')}</Tabs.Tab>
            <Tabs.Tab value="team">{t('settings.agentRoles.teamTab')}</Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
        {editor && editorValue ? (
          <AgentRoleForm
            tab={tab}
            value={editorValue}
            memoryPicker={
              editorTarget ? (
                <RoleMemoryPicker
                  key={editorTarget.machineId}
                  machineId={editorTarget.machineId}
                  value={editorTarget.memory}
                  onChange={(memory) => {
                    if (openEditor)
                      onChange({
                        ...openEditor,
                        value: putAgentRoleFormTarget(editorValue, { ...editorTarget, memory }),
                      });
                  }}
                />
              ) : undefined
            }
            addTargetPanel={
              activeMachineId && !editorTarget ? (
                <AddAgentRoleTargetPanel
                  key={activeMachineId}
                  machineId={activeMachineId}
                  machineLabel={
                    machineOptions.find((option) => option.machineId === activeMachineId)?.label ??
                    ''
                  }
                  source={sourceTarget}
                  sourceConfig={sourceConfig}
                  machineConfigs={machineAgentConfigs}
                  onAdd={(target) => {
                    if (openEditor)
                      onChange({
                        ...openEditor,
                        value: putAgentRoleFormTarget(editorValue, target),
                      });
                  }}
                />
              ) : undefined
            }
            // A panel fading out is not edited: a change there would reopen it.
            onChange={(value) => {
              if (!openEditor) return;
              const nextTarget = getAgentRoleFormTarget(value);
              const modelChanged =
                nextTarget !== undefined &&
                editorTarget !== undefined &&
                nextTarget.machineId === editorTarget.machineId &&
                nextTarget.agentConfigId === editorTarget.agentConfigId &&
                nextTarget.modelId !== editorTarget.modelId;
              onChange({
                ...openEditor,
                value:
                  modelChanged && nextTarget
                    ? putAgentRoleFormTarget(value, {
                        ...nextTarget,
                        configOptionValues: carryAgentRoleOptionsToModel(
                          nextTarget.configOptionValues,
                          selectorOptions.configOptionSelectors,
                          buildAcpSelectorOptions(
                            selectorTarget && {
                              ...selectorTarget,
                              selectedModelId: nextTarget.modelId,
                            }
                          ).configOptionSelectors
                        ),
                      })
                    : value,
              });
            }}
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
      </Dialog.Content>
    </Dialog.Root>
  );
}

const styles = stylex.create({
  addPanel: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px' },
  icon: { width: '14px', height: '14px' },
});

/**
 * A machine tab the Role does not run on yet: one action that adds it, with the
 * same agent preselected when this machine has one, and what that will be.
 */
function AddAgentRoleTargetPanel({
  machineId,
  machineLabel,
  source,
  sourceConfig,
  machineConfigs,
  onAdd,
}: {
  machineId: MachineId;
  machineLabel: string;
  source: AgentRoleTargetFormValue | undefined;
  sourceConfig: AgentConfigMeta | undefined;
  machineConfigs: readonly AgentConfigMeta[];
  onAdd: (target: AgentRoleTargetFormValue) => void;
}) {
  const { t } = useTranslation();
  const { entries } = useMemoryAssociations(machineId);
  const suggestion = suggestAgentRoleTarget({
    machineId,
    source,
    sourceConfig,
    machineConfigs,
    memories: entries,
  });
  const suggestedConfig = machineConfigs.find((config) => config.id === suggestion.agentConfigId);
  return (
    <div {...stylex.props(styles.addPanel)}>
      <p {...stylex.props(catalog.meta)}>
        {suggestedConfig
          ? t('settings.agentRoles.form.addToMachineMatched', {
              machine: machineLabel,
              agent: suggestedConfig.name,
            })
          : t('settings.agentRoles.form.addToMachineHint', { machine: machineLabel })}
      </p>
      <Button type="button" size="small" variant="secondary" onClick={() => onAdd(suggestion)}>
        <Plus aria-hidden="true" {...stylex.props(styles.icon)} />
        {t('settings.agentRoles.form.addToMachine')}
      </Button>
    </div>
  );
}
