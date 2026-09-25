import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { Plus, Trash2, UserRoundCog } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
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
import { AlertDialog } from '@/ui/dialog';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';
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
    <div {...stylex.props(surface.container)}>
      <p {...stylex.props(catalog.intro)}>{t('settings.agentRoles.description')}</p>

      <section {...stylex.props(surface.section)}>
        <header {...stylex.props(surface.sectionHeader)}>
          <div {...stylex.props(catalog.heading)}>
            <h3 {...stylex.props(surface.sectionTitle)}>{t('settings.agentRoles.catalogTitle')}</h3>
            {roles.length > 0 ? <span {...stylex.props(catalog.count)}>{roles.length}</span> : null}
            {!synced ? (
              <span {...stylex.props(catalog.syncing)}>
                <Spinner size="small" aria-hidden="true" />
                {t('settings.agentRoles.syncing')}
              </span>
            ) : null}
          </div>
          <div {...stylex.props(surface.sectionActions)}>
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button variant="ghost" aria-label={addLabel} size="small" icon onClick={openAdd}>
                    <Plus {...stylex.props(catalog.icon)} />
                  </Button>
                }
              />
              <Tooltip.Content>{addLabel}</Tooltip.Content>
            </Tooltip.Root>
          </div>
        </header>

        {roles.length === 0 ? (
          <div {...stylex.props(catalog.empty)}>
            <UserRoundCog {...stylex.props(catalog.emptyIcon)} aria-hidden="true" />
            <p {...stylex.props(catalog.emptyText)}>{t('settings.agentRoles.empty')}</p>
            <Button size="small" variant="secondary" onClick={openAdd}>
              <Plus {...stylex.props(catalog.icon)} />
              {addLabel}
            </Button>
          </div>
        ) : (
          <div {...stylex.props(catalog.groups)}>
            {roleGroups.map((group) => (
              <div key={group.machineId} {...stylex.props(catalog.group)}>
                {/* The machine leads its group instead of repeating on every row:
                    a Role binds one machine exactly, so it is what the list is
                    grouped BY, not a fact about each entry. */}
                <MachineGroupHeading
                  label={group.machineLabel}
                  online={onlineMachineIds.has(group.machineId)}
                />
                <div {...stylex.props(surface.card)}>
                  {group.roles.map((role, index) => (
                    <div
                      key={role.id}
                      {...stylex.props(surface.line, index > 0 && surface.lineRuled)}
                    >
                      <AgentRoleRow
                        role={role}
                        availability={resolve(role)}
                        agentConfig={agentConfigs.find((entry) => entry.id === role.agentConfigId)}
                        canManage={canManageAgentRole(role, currentUserId)}
                        onEdit={() => openEdit(role)}
                        onRemove={() => setPendingRemoval(role)}
                      />
                    </div>
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

      <AlertDialog.Root
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemoval(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('settings.agentRoles.removeTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('settings.agentRoles.confirmRemove', { name: pendingRemoval?.name ?? '' })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={removing}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={removing}
              variant="destructive"
              onClick={() => {
                void confirmRemoval();
              }}
            >
              {removing ? <Spinner size="small" /> : null}
              {t('common.remove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

/**
 * One catalog row. It is a line of its machine's card, not a card of its own:
 * the list draws the card and the rule between rows.
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
    <div {...stylex.props(catalog.row, surface.pressableLine)}>
      <button
        type="button"
        onClick={onEdit}
        aria-label={canManage ? t('common.edit') : t('common.view')}
        {...stylex.props(catalog.rowMain)}
      >
        <span {...stylex.props(catalog.glyph)}>
          <span aria-hidden="true">{getAgentRoleEmoji(role)}</span>
        </span>
        <span {...stylex.props(catalog.body)}>
          <span {...stylex.props(catalog.titleLine)}>
            {/* No `@token` here: it is derived from this very name, so printing
                both says one thing twice. */}
            <span {...stylex.props(catalog.name)}>{role.name}</span>
            <Badge>
              {role.visibility === 'workspace'
                ? t('settings.agentRoles.visibility.workspace')
                : t('settings.agentRoles.visibility.private')}
            </Badge>
            {role.promptPrefix ? <Badge>{t('settings.agentRoles.hasPrompt')}</Badge> : null}
          </span>
          <span {...stylex.props(catalog.meta)}>
            {agentConfig ? (
              <AgentIcon
                cliType={agentConfig.cliType}
                agentType={agentConfig.agentType}
                brandId={agentConfig.brandId}
                env={agentConfig.env}
                className={stylex.props(catalog.iconSmall).className}
              />
            ) : null}
            <span {...stylex.props(catalog.truncate)}>
              {runConfig.length > 0
                ? runConfig.join(' · ')
                : (agentConfig?.name ?? t('settings.agentRoles.unknownAgentConfig'))}
            </span>
          </span>
          <AgentRoleAvailabilityText availability={availability} />
        </span>
      </button>
      <div {...stylex.props(catalog.actions)}>
        {canManage ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={t('common.remove')}
            size="small"
            icon
            tone="destructive"
            onClick={onRemove}
          >
            <Trash2 {...stylex.props(catalog.icon)} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The machine's name above its card of Roles: a heading, not a bordered pill. */
function MachineGroupHeading({ label, online }: { label: string; online: boolean }) {
  const { t } = useTranslation();
  return (
    <h4 {...stylex.props(catalog.groupHeading)}>
      <span
        aria-hidden="true"
        {...stylex.props(catalog.statusDot, online && catalog.statusDotOnline)}
      />
      <span {...stylex.props(catalog.groupHeadingLabel)}>{label}</span>
      {/* The dot is the whole signal now that rows no longer repeat "its machine
          is offline", so it needs a text equivalent for anyone not seeing it. */}
      {online ? null : (
        <span {...stylex.props(catalog.srOnly)}>{t('settings.agentRoles.status.offline')}</span>
      )}
    </h4>
  );
}

/**
 * Why a Role cannot run, when the list does not already say so.
 *
 * `machine_offline` says nothing new: the Role sits under its machine's heading,
 * which carries that machine's status — repeating it on every row in the group
 * is the same sentence N times. The reasons that stay are the ones the heading
 * cannot show, because they are about this Role's binding rather than the
 * machine's state.
 */
function AgentRoleAvailabilityText({ availability }: { availability: AgentRoleAvailability }) {
  const { t } = useTranslation();
  if (availability.kind === 'available') return null;
  if (availability.kind === 'unknown') {
    return (
      <span {...stylex.props(catalog.meta, catalog.metaHint)}>
        <span {...stylex.props(catalog.truncate)}>{t('settings.agentRoles.status.checking')}</span>
      </span>
    );
  }
  if (availability.reason === 'machine_offline') return null;
  const reason = t(AGENT_ROLE_UNAVAILABLE_REASON_KEYS[availability.reason]);
  return (
    <span {...stylex.props(catalog.meta, catalog.metaWarning)}>
      <span {...stylex.props(catalog.truncate)}>
        {t('settings.agentRoles.unavailable.label', { reason })}
      </span>
    </span>
  );
}
