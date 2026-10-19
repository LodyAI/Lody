import { useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import { Plus, Trash2 } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import {
  bindAgentRoleTarget,
  canManageAgentRole,
  getAgentRoleEmoji,
  getAgentRoleTarget,
  getAgentRoleTargets,
  type AgentConfigMeta,
  type AgentRole,
  type AgentRoleAvailability,
  type MachineId,
} from '@lody/shared';
import { userAtom, settingsSelectedMachineIdAtom } from '@/atoms';
import { getAllAgentConfigAtom } from '@/atoms/agents';
import { onlineMachineIdsAtom } from '@/atoms/presence';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import {
  useAgentRoleAvailability,
  useWorkspaceAgentRoleActions,
  useWorkspaceAgentRoles,
} from '@/hooks/use-workspace-agent-roles';
import { AgentIcon } from '@/components/icons/agent-icon';
import { buildAgentRoleRunConfigSummary, createAgentRoleFormValue } from '@/lib/agent-role-form';
import { AGENT_ROLE_UNAVAILABLE_REASON_KEYS } from '@/lib/composer-agent-roles';
import { AlertDialog } from '@/ui/dialog';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { SettingsPageActions, SettingsPageLead } from './settings-page-header';
import { SettingsEmptyList, settingsRecordsCard } from './compact-layout';
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
  const selectedMachineId = useAtomValue(settingsSelectedMachineIdAtom);
  const targetMachineId =
    selectedMachineId &&
    (machines.has(selectedMachineId) ||
      roles.some((role) => getAgentRoleTarget(role, selectedMachineId) !== undefined))
      ? selectedMachineId
      : null;
  const { resolve } = useAgentRoleAvailability(roles);
  const { remove } = useWorkspaceAgentRoleActions();

  const [editor, setEditor] = useState<AgentRoleEditorState | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<AgentRole | null>(null);
  const [removing, setRemoving] = useState(false);

  // One list of Roles, by name. A Role may run on several machines, so the
  // machine is a fact each row states rather than what the list is grouped by.
  const rows = useMemo(() => {
    const machineCount = machines.size;
    return roles.map((role) => {
      const targets = getAgentRoleTargets(role).map((target): AgentRoleRowTarget => {
        const bound = bindAgentRoleTarget(role, target.machineId) ?? role;
        return {
          machineId: target.machineId,
          label: machines.get(target.machineId)?.name ?? t('settings.agentRoles.unknownMachine'),
          online: onlineMachineIds.has(target.machineId),
          availability: resolve(bound),
          runConfig: target.runConfig,
          agentConfig: agentConfigs.find((entry) => entry.id === target.agentConfigId),
        };
      });
      const allMachines =
        targets.length > 1 &&
        targets.length >= machineCount &&
        [...machines.keys()].every((machineId) =>
          targets.some((target) => target.machineId === machineId)
        );
      return { role, targets, allMachines };
    });
  }, [agentConfigs, machines, onlineMachineIds, resolve, roles, t]);

  // Arriving from a memory's "Link to a role" names a machine: bring the first
  // Role that runs there into view, and open Roles on that machine's tab.
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const positionedMachine = useRef<MachineId | null>(null);
  useEffect(() => {
    if (!targetMachineId) {
      positionedMachine.current = null;
      return;
    }
    if (positionedMachine.current === targetMachineId) return;
    const first = rows.find((row) =>
      row.targets.some((target) => target.machineId === targetMachineId)
    );
    const element = first ? rowElements.current.get(first.role.id) : undefined;
    if (element) {
      element.scrollIntoView({ block: 'nearest' });
      positionedMachine.current = targetMachineId;
    }
  }, [targetMachineId, rows]);

  // A new Role starts on the machine the page was opened for, else an online
  // one, so the editor opens on a machine tab rather than none.
  const openAdd = () =>
    setEditor(
      openAgentRoleEditorForCreate(
        createAgentRoleFormValue(
          targetMachineId ??
            [...machines.keys()].find((machineId) => onlineMachineIds.has(machineId)) ??
            [...machines.keys()][0] ??
            null
        )
      )
    );
  const openEdit = (role: AgentRole) =>
    setEditor(
      openAgentRoleEditorForEdit(
        role,
        targetMachineId && getAgentRoleTarget(role, targetMachineId) ? targetMachineId : undefined
      )
    );

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
      <SettingsPageLead>{t('settings.agentRoles.description')}</SettingsPageLead>

      <SettingsPageActions>
        {!synced ? (
          <span {...stylex.props(catalog.syncing)}>
            <Spinner size="small" aria-hidden="true" />
            {t('settings.agentRoles.syncing')}
          </span>
        ) : null}
        <Button size="small" variant="secondary" onClick={openAdd}>
          <Plus {...stylex.props(catalog.icon)} />
          {addLabel}
        </Button>
      </SettingsPageActions>

      {rows.length === 0 ? (
        <SettingsEmptyList>{t('settings.agentRoles.empty')}</SettingsEmptyList>
      ) : (
        // One provider: after the first machine note opens, the next opens at once.
        <Tooltip.Provider delay={250}>
          <div {...stylex.props(settingsRecordsCard)}>
            {rows.map((row, index) => (
              <div
                key={row.role.id}
                ref={(element) => {
                  if (element) rowElements.current.set(row.role.id, element);
                  else rowElements.current.delete(row.role.id);
                }}
                {...stylex.props(surface.line, index > 0 && surface.lineRuled)}
              >
                <AgentRoleRow
                  role={row.role}
                  targets={row.targets}
                  allMachines={row.allMachines}
                  canManage={canManageAgentRole(row.role, currentUserId)}
                  onEdit={() => openEdit(row.role)}
                  onRemove={() => setPendingRemoval(row.role)}
                />
              </div>
            ))}
          </div>
        </Tooltip.Provider>
      )}

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

/** One machine a Role runs on, as its row states it. */
export type AgentRoleRowTarget = {
  machineId: MachineId;
  label: string;
  online: boolean;
  availability: AgentRoleAvailability;
  runConfig: AgentRole['runConfig'];
  /** The bound config, when it still exists; its icon stands for the agent. */
  agentConfig?: Pick<AgentConfigMeta, 'cliType' | 'agentType' | 'brandId' | 'env' | 'name'>;
};

/**
 * One catalog row. It is a line of the list's card, not a card of its own: the
 * list draws the card and the rule between rows.
 *
 * Always two lines, whatever the Role's state: what it is (name, marks) over
 * what it runs (agent, model, reasoning), with where it runs in a column of its
 * own on the right. A machine that cannot run it is marked on that machine, with
 * the reason on hover, rather than by a third line — so rows in one list keep one
 * height. A target whose binding is gone stays listed and editable; it never
 * quietly re-points at something that happens to be available.
 */
export function AgentRoleRow({
  role,
  targets,
  allMachines = false,
  canManage,
  onEdit,
  onRemove,
}: {
  role: AgentRole;
  /** One per machine the Role runs on, first target first. */
  targets: readonly AgentRoleRowTarget[];
  /** The Role runs on every machine this user can reach (two or more). */
  allMachines?: boolean;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [first] = targets;
  const summaries = targets.map((target) => ({
    text: buildAgentRoleRunConfigSummary(target.runConfig).join(' · '),
    agent: target.agentConfig?.name ?? '',
  }));
  // Two machines running the Role the same way read as one line; when they
  // differ, the row says so instead of picking one to show.
  const uniform = summaries.every(
    (summary) => summary.text === summaries[0]?.text && summary.agent === summaries[0]?.agent
  );
  const runConfig = uniform ? (summaries[0]?.text ?? '') : '';

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
          <span {...stylex.props(catalog.titleLine, styles.titleLine)}>
            {/* No `@token` here: it is derived from this very name, so printing
                both says one thing twice. */}
            <span {...stylex.props(catalog.name)}>{role.name}</span>
            {/* Private is the default and says nothing on every row; only a Role
                the whole workspace can use is marked. */}
            {role.visibility === 'workspace' ? (
              <Badge>{t('settings.agentRoles.visibility.workspace')}</Badge>
            ) : null}
            {role.promptPrefix ? <Badge>{t('settings.agentRoles.hasPrompt')}</Badge> : null}
          </span>
          <span {...stylex.props(catalog.meta)}>
            {uniform && first?.agentConfig ? (
              <AgentIcon
                cliType={first.agentConfig.cliType}
                agentType={first.agentConfig.agentType}
                brandId={first.agentConfig.brandId}
                env={first.agentConfig.env}
                className={stylex.props(catalog.iconSmall).className}
              />
            ) : null}
            <span {...stylex.props(catalog.truncate)}>
              {!uniform
                ? t('settings.agentRoles.configuredPerMachine')
                : runConfig ||
                  (first?.agentConfig?.name ?? t('settings.agentRoles.unknownAgentConfig'))}
            </span>
          </span>
        </span>
      </button>
      <AgentRoleMachines targets={targets} allMachines={allMachines} />
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

/** Machines named in the trailing column before the rest fold into "+N". */
const MACHINES_SHOWN = 2;

type MachineState = 'ready' | 'offline' | 'checking' | 'problem';

const machineState = (target: AgentRoleRowTarget): MachineState => {
  const { availability } = target;
  if (availability.kind === 'unknown') return 'checking';
  if (availability.kind === 'unavailable' && availability.reason !== 'machine_offline')
    return 'problem';
  return target.online ? 'ready' : 'offline';
};

/**
 * Where a Role runs, in the row's trailing column: each machine with a dot that
 * carries its state, or — on every machine — that fact in words, which stays
 * short however many there are. A machine with a binding problem turns warning
 * and says why on hover; so does a still-unjudged one, so neither costs a line.
 */
function AgentRoleMachines({
  targets,
  allMachines,
}: {
  targets: readonly AgentRoleRowTarget[];
  allMachines: boolean;
}) {
  const { t } = useTranslation();
  const describe = (target: AgentRoleRowTarget): string => {
    const state = machineState(target);
    if (state === 'checking') return t('settings.agentRoles.status.checking');
    if (state === 'offline') return t('settings.agentRoles.status.offline');
    if (state === 'problem' && target.availability.kind === 'unavailable') {
      return t('settings.agentRoles.unavailable.label', {
        reason: t(AGENT_ROLE_UNAVAILABLE_REASON_KEYS[target.availability.reason]),
      });
    }
    return '';
  };
  const noteFor = (list: readonly AgentRoleRowTarget[]) =>
    list
      .map((target) => {
        const note = describe(target);
        return note ? `${target.label}: ${note}` : target.label;
      })
      .join('\n');

  if (allMachines) {
    const problems = targets.filter((target) => machineState(target) === 'problem');
    return (
      <MachineMark
        state={problems.length > 0 ? 'problem' : 'ready'}
        label={t('settings.agentRoles.allMachines', { count: targets.length })}
        note={problems.length > 0 ? noteFor(problems) : undefined}
      />
    );
  }

  const shown = targets.slice(0, MACHINES_SHOWN);
  const folded = targets.slice(MACHINES_SHOWN);
  return (
    <span {...stylex.props(styles.machines)}>
      {shown.map((target) => (
        <MachineMark
          key={target.machineId}
          state={machineState(target)}
          label={target.label}
          note={describe(target) || undefined}
        />
      ))}
      {folded.length > 0 ? (
        <MachineMark
          state={folded.some((target) => machineState(target) === 'problem') ? 'problem' : 'none'}
          label={`+${folded.length}`}
          note={noteFor(folded)}
        />
      ) : null}
    </span>
  );
}

function MachineMark({
  state,
  label,
  note,
}: {
  state: MachineState | 'none';
  label: string;
  /** Said on hover and to a screen reader: why this machine is not ready. */
  note?: string;
}) {
  const mark = (
    <span {...stylex.props(styles.machine, state === 'problem' && styles.machineProblem)}>
      {state === 'none' ? null : (
        <span
          aria-hidden="true"
          {...stylex.props(
            catalog.statusDot,
            state === 'ready' && catalog.statusDotOnline,
            state === 'problem' && styles.dotProblem,
            state === 'checking' && styles.dotChecking
          )}
        />
      )}
      <span {...stylex.props(catalog.truncate, styles.machineLabel)}>{label}</span>
      {note ? <span {...stylex.props(catalog.srOnly)}>{note}</span> : null}
    </span>
  );
  if (!note) return mark;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={mark} />
      <Tooltip.Content side="top">
        <span {...stylex.props(styles.note)}>{note}</span>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

const styles = stylex.create({
  /** A badge's height whether or not the Role has one, so every row is one height. */
  titleLine: { flexWrap: 'nowrap', height: '20px' },
  machines: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: '12px',
    maxWidth: '45%',
    minWidth: 0,
    paddingInlineStart: '12px',
  },
  machine: {
    display: 'inline-flex',
    flexShrink: 1,
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
    fontSize: '12px',
    lineHeight: '16px',
    color: colors.secondaryLabel,
    cursor: 'default',
  },
  machineProblem: { color: colors.warning },
  machineLabel: { maxWidth: '120px' },
  dotProblem: { backgroundColor: colors.warning },
  /** Not judged yet: a ring, not a verdict. */
  dotChecking: {
    backgroundColor: 'transparent',
    boxShadow: `inset 0 0 0 1px ${colors.tertiaryLabel}`,
  },
  note: { whiteSpace: 'pre-line' },
});
