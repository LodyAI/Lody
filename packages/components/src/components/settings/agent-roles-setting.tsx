import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Loader2, Plus, Trash2, UserRoundCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  canManageAgentRole,
  getAgentRoleEmoji,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type MachineId,
} from '@lody/shared';
import { userAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import {
  useAgentRoleAvailability,
  useWorkspaceAgentRoleActions,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';
import { AgentIcon } from '@/components/icons/agent-icon';
import { buildAgentRoleRunConfigSummary, EMPTY_AGENT_ROLE_FORM_VALUE } from '@/lib/agent-role-form';
import { AGENT_ROLE_UNAVAILABLE_REASON_KEYS } from '@/lib/composer-agent-roles';
import { cn } from '@/lib/utils';
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
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { SettingsEmptyState, SettingsPage } from './settings-page';
import {
  AgentRoleEditorDialog,
  openAgentRoleEditorForCreate,
  openAgentRoleEditorForEdit,
  type AgentRoleEditorState,
} from './agent-role-editor-dialog';

/**
 * Settings → Agent Roles.
 *
 * Deliberately its own page beside Agents rather than a tab inside the provider
 * dialog: a provider says how an agent starts, a Role says how one is used, and
 * merging the two surfaces is what makes people expect a Role to carry
 * credentials.
 */
export function AgentRolesSetting() {
  const { t } = useTranslation();
  const currentUserId = useAtomValue(userAtom)?.id ?? null;
  const onlineMachineIds = useAtomValue(onlineMachineIdsAtom);
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const { machines } = useVisibleMachineMetas();
  const { roles, synced } = useWorkspaceAgentRoles();
  const { resolve } = useAgentRoleAvailability(roles);
  const { remove } = useWorkspaceAgentRoleActions();

  const [editor, setEditor] = useState<AgentRoleEditorState | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<AgentRole | null>(null);
  const [removing, setRemoving] = useState(false);

  // One group per machine the accessible Roles actually point at, ordered by
  // label so the list does not reshuffle when a machine goes offline.
  const roleGroups = useMemo(() => {
    const byMachine = new Map<MachineId, AgentRole[]>();
    for (const role of roles) {
      const existing = byMachine.get(role.machineId);
      if (existing) existing.push(role);
      else byMachine.set(role.machineId, [role]);
    }
    return [...byMachine.entries()]
      .map(([machineId, machineRoles]) => ({
        machineId,
        machineLabel: machines.get(machineId)?.name ?? t('settings.agentRoles.unknownMachine'),
        roles: machineRoles,
      }))
      .sort((left, right) => left.machineLabel.localeCompare(right.machineLabel));
  }, [machines, roles, t]);

  const openAdd = () => setEditor(openAgentRoleEditorForCreate({ ...EMPTY_AGENT_ROLE_FORM_VALUE }));
  const openEdit = (role: AgentRole) => setEditor(openAgentRoleEditorForEdit(role));

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    setRemoving(true);
    try {
      await remove(pendingRemoval.id);
    } catch (cause) {
      console.error('Failed to delete agent role', cause);
    } finally {
      setRemoving(false);
      setPendingRemoval(null);
    }
  };

  const addLabel = t('settings.agentRoles.add');
  return (
    <SettingsPage
      title={t('settings.tabs.agentRoles')}
      description={t('settings.agentRoles.description')}
    >
      <section className="flex flex-col">
        <div className="flex items-center justify-between gap-2 pb-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {t('settings.agentRoles.catalogTitle')}
            </h3>
            {roles.length > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground/70">{roles.length}</span>
            ) : null}
            {!synced ? (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t('settings.agentRoles.syncing')}
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
                onClick={openAdd}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{addLabel}</TooltipContent>
          </Tooltip>
        </div>

        {roles.length === 0 ? (
          <SettingsEmptyState
            icon={<UserRoundCog aria-hidden="true" />}
            message={t('settings.agentRoles.empty')}
            action={
              <Button size="sm" onClick={openAdd}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {addLabel}
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {roleGroups.map((group) => (
              <div key={group.machineId} className="space-y-1.5">
                {/* The machine leads its group instead of repeating on every row:
                    a Role binds one machine exactly, so it is what the list is
                    grouped BY, not a fact about each entry. */}
                <MachineGroupPill
                  label={group.machineLabel}
                  online={onlineMachineIds.has(group.machineId)}
                />
                <div className="space-y-2">
                  {group.roles.map((role) => (
                    <AgentRoleRow
                      key={role.id}
                      role={role}
                      availability={resolve(role)}
                      agentConfig={agentConfigs.find((entry) => entry.id === role.agentConfigId)}
                      canManage={canManageAgentRole(role, currentUserId)}
                      onEdit={() => openEdit(role)}
                      onRemove={() => setPendingRemoval(role)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <AgentRoleEditorDialog
        editor={editor}
        accessibleRoles={roles}
        onChange={setEditor}
        onClose={() => setEditor(null)}
        source="settings"
      />

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.agentRoles.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.agentRoles.confirmRemove', { name: pendingRemoval?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                void confirmRemoval();
              }}
            >
              {removing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('common.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}

/**
 * One catalog row.
 *
 * States the whole binding — machine, provider, model, reasoning — because that
 * is what a Role IS, and says exactly why it cannot run when it cannot. A row
 * whose target is gone stays listed and editable; it never quietly re-points at
 * something that happens to be available.
 */
export function AgentRoleRow({
  role,
  availability,
  agentConfig,
  canManage,
  onEdit,
  onRemove,
}: {
  role: AgentRole;
  availability: AgentRoleAvailability;
  /** The bound config, when it still exists; its icon stands for the agent. */
  agentConfig?: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env' | 'name'>;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const runConfig = buildAgentRoleRunConfigSummary(role.runConfig);

  return (
    <div className="overflow-hidden rounded-lg bg-foreground/[0.04]">
      <div className="flex w-full min-w-0 items-center transition-colors hover:bg-hover/40">
        <button
          type="button"
          onClick={onEdit}
          aria-label={canManage ? t('common.edit') : t('common.view')}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-sm leading-none">
            <span aria-hidden="true">{getAgentRoleEmoji(role)}</span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              {/* No `@token` here: it is derived from this very name, so printing
                  both says one thing twice. */}
              <span className="min-w-0 truncate text-sm font-medium leading-tight">
                {role.name}
              </span>
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                {role.visibility === 'workspace'
                  ? t('settings.agentRoles.visibility.workspace')
                  : t('settings.agentRoles.visibility.private')}
              </Badge>
              {role.promptPrefix ? (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                  {t('settings.agentRoles.hasPrompt')}
                </Badge>
              ) : null}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground">
              {agentConfig ? (
                <AgentIcon
                  cliType={agentConfig.cliType}
                  agentType={agentConfig.agentType}
                  brandId={agentConfig.brandId}
                  env={agentConfig.env}
                  className="h-3 w-3 shrink-0"
                />
              ) : null}
              <span className="min-w-0 truncate">
                {runConfig.length > 0
                  ? runConfig.join(' · ')
                  : (agentConfig?.name ?? t('settings.agentRoles.unknownAgentConfig'))}
              </span>
            </span>
            <AgentRoleAvailabilityText availability={availability} />
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1 py-2 pl-2 pr-2">
          {canManage ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={t('common.remove')}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The machine heading above a group of Roles: the pill grammar of the other
 *  settings surfaces, as a label rather than a selector. */
function MachineGroupPill({ label, online }: { label: string; online: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          online ? 'bg-status-success' : 'bg-muted-foreground/40'
        )}
      />
      <span className="min-w-0 truncate">{label}</span>
      {/* The dot is the whole signal now that rows no longer repeat "its machine
          is offline", so it needs a text equivalent for anyone not seeing it. */}
      {online ? null : <span className="sr-only">{t('settings.agentRoles.status.offline')}</span>}
    </div>
  );
}

/**
 * Why a Role cannot run, when the list does not already say so.
 *
 * `machine_offline` says nothing new: the Role sits under its machine's pill,
 * which carries that machine's status — repeating it on every row in the group
 * is the same sentence N times. The reasons that stay are the ones the pill
 * cannot show, because they are about this Role's binding rather than the
 * machine's state.
 */
function AgentRoleAvailabilityText({ availability }: { availability: AgentRoleAvailability }) {
  const { t } = useTranslation();
  if (availability.kind === 'available') return null;
  if (availability.kind === 'unknown') {
    return (
      <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground/80">
        {t('settings.agentRoles.status.checking')}
      </span>
    );
  }
  if (availability.reason === 'machine_offline') return null;
  const reason = t(AGENT_ROLE_UNAVAILABLE_REASON_KEYS[availability.reason]);
  return (
    <span className="mt-0.5 block truncate text-[11px] leading-tight text-status-warning">
      {t('settings.agentRoles.unavailable.label', { reason })}
    </span>
  );
}
