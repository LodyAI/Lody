import { useWorkspaceCatalog } from '../hooks/use-workspace-catalog';
import { workspaceSnapshotSource } from './workspace-snapshot-source';
import { PendingInteractionObserver } from './pending-interaction';
import { useState, useCallback, useSyncExternalStore } from 'react';
import type { PendingInteractionSummary, InstalledPluginSummary } from '@lody/plugin-sdk';
const noSubscribe = () => () => {};
const zero = () => 0;
import { readWorkspaceResource } from './workspace-resources';
import { localProbeResultAtom } from '../atoms/local-probe';
import { machineFlockRowsByWorkspaceAtom } from '../atoms/machine-flock';
import {
  resolveSessionWorkspacePath,
  resolveMachineDotlodyPath,
} from '../lib/session-workspace-path';
import { eventRefs } from './session-events';
import { useSchedules } from '../hooks/use-schedules';
import { publishPluginSidebarRows } from './shell-surfaces';
import { readPluginHistory } from './workspace-history';
import { summarizeSession } from './workspace-sessions';
import { useVisibleArchivedSessionMetas } from '../hooks/use-visible-session-metas';
import { docMetaCacheReadyAtom } from '../atoms/doc-meta';
import { usePluginSessionMetaEvents } from './use-session-events';
import { useVisibleSessionMetas as usePluginVisibleSessions } from '../hooks/use-visible-session-metas';
import { useWorkspaceMembers } from '../hooks/use-workspace-members';
import { useVisibleMachineMetas } from '../hooks/use-visible-machine-metas';
import { getAllAgentConfigAtom, workflowCatalogAtom } from '../atoms/agents';
import type { ProjectRef, MachineRef } from '@lody/plugin-sdk';
import { useVisibleLocalProjects } from '../hooks/use-visible-local-projects';
import { WorkspacePluginReads } from './workspace-client';
import {
  useWorkspaceAgentRoles,
  useAgentRoleAvailability,
} from '../hooks/use-workspace-agent-roles';
import { useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { activeWorkspaceRuntimeAtom } from '../atoms/runtime';
import { useOnlineMachines } from '../hooks/use-online-machines';
import { useWorkspaceLocalAccountId } from '../lib/e2ee-account';
import { readPluginCatalog, type CatalogMachine } from './workspace-catalog';
import { useWorkspaceClientPlugins } from './client-host-provider';
import { createWorkspacePluginRegistry } from './workspace-plugin-registry';

export function PluginCatalogSubscriber() {
  const owner = useWorkspaceClientPlugins(),
    runtime = useAtomValue(activeWorkspaceRuntimeAtom),
    account = useWorkspaceLocalAccountId(),
    machines = useOnlineMachines();
  const revision = useSyncExternalStore(
    owner?.subscribe ?? noSubscribe,
    owner?.snapshot ?? zero,
    zero
  );
  const publishWorkflowCatalog = useSetAtom(workflowCatalogAtom);
  useEffect(() => {
    if (!owner || !runtime || owner.workspaceId !== runtime.workspaceId) return;
    const entries = owner
      .installations()
      .filter((i) => i.enabled && i.dev.owner && i.workflowPrompts);
    publishWorkflowCatalog({
      workspaceId: owner.workspaceId,
      providers: entries.flatMap((i) =>
        (i.dev.manifest.acpProviders ?? []).map((p) => ({
          id: `plugin:${i.pluginId}:${p.id}` as import('@lody/shared').AgentConfigId,
          machineId: i.machineId as import('@lody/shared').MachineId,
          name: p.title,
          description: p.description,
          env: {},
          cliType: 'custom' as const,
          agentType: `plugin:${i.pluginId}:${p.id}`,
        }))
      ),
      servers: entries.flatMap((i) =>
        (i.dev.manifest.mcpServers ?? []).map((s) => ({
          id: `plugin:${i.pluginId}:${s.id}` as import('@lody/shared').McpServerId,
          name: s.title,
          description: s.description,
          transport: s.transport,
          createdAt: 0,
          updatedAt: 0,
        }))
      ),
    });
  }, [owner, runtime, revision, publishWorkflowCatalog]);
  useEffect(() => () => publishWorkflowCatalog(null), [owner, publishWorkflowCatalog]);
  const [pending, setPending] = useState<Record<string, PendingInteractionSummary | undefined>>({});
  const publishPending = useCallback(
    (id: string, value?: PendingInteractionSummary) =>
      setPending((prev) => (prev[id] === value ? prev : { ...prev, [id]: value })),
    []
  );
  const visible = usePluginVisibleSessions();
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const metaReady = useAtomValue(docMetaCacheReadyAtom);
  usePluginSessionMetaEvents(
    owner?.workspaceId,
    metaReady && !visible.isLoading && runtime?.workspaceId === owner?.workspaceId,
    visible.allActiveSessions
  );
  const reads = useMemo(() => new WorkspacePluginReads(owner?.workspaceId ?? ''), [owner]);
  const workspaceCatalog = useWorkspaceCatalog();
  const { roles, synced } = useWorkspaceAgentRoles();
  const { projects } = useVisibleLocalProjects();
  const { members } = useWorkspaceMembers();
  const { machines: visibleMachines } = useVisibleMachineMetas();
  const schedule = useSchedules();
  const flock = useAtomValue(machineFlockRowsByWorkspaceAtom);
  const configs = useAtomValue(getAllAgentConfigAtom);
  const local = useAtomValue(localProbeResultAtom)?.machineId;
  const availability = useAgentRoleAvailability(roles);
  useEffect(() => {
    if (!owner || runtime?.workspaceId !== owner.workspaceId) return;
    const summaries = [...visible.allActiveSessions, ...archivedSessions].map((s) => ({
      ...summarizeSession(
        owner.workspaceId,
        s,
        account,
        machines.some((m) => m.id === s.machineId)
      ),
      pendingInteraction: s.status?.type === 'requestPermission' ? pending[s.id] : undefined,
    }));
    const detach = publishPluginSidebarRows(owner.workspaceId, summaries);
    reads.publish({
      snapshots: workspaceSnapshotSource(
        runtime,
        account,
        visible.allActiveSessions,
        archivedSessions,
        projects,
        roles,
        schedule.rows,
        {
          mcpServers: workspaceCatalog.servers,
          workspaceProjects: workspaceCatalog.projects,
          pinSections: workspaceCatalog.pinSections,
          projectMcpDefaults: workspaceCatalog.projectMcpDefaults,
        }
      ),
      plugins: owner.installations().map((i) => {
        const lifecycle = i.inspection?.lifecycle.toLowerCase();
        const state: InstalledPluginSummary['state'] = !i.enabled
          ? 'disabled'
          : lifecycle === 'running' || lifecycle === 'faulted' || lifecycle === 'stopping'
            ? lifecycle
            : 'starting';
        return {
          pluginId: i.pluginId,
          title: i.dev.manifest.title,
          version: i.dev.manifest.version,
          enabled: i.enabled,
          state,
          clientDigest: i.digest,
          devMode: i.dev.devMode,
          machine: { workspaceId: owner.workspaceId, machineId: i.dev.machineId } as MachineRef,
        };
      }),
      resource: (target, id, input, signal) =>
        readWorkspaceResource(
          runtime,
          account,
          new Set(visibleMachines.keys()),
          projects,
          [...visible.allActiveSessions, ...archivedSessions],
          local,
          target,
          id,
          input,
          signal
        ),
      schedules: schedule.rows.map((r) => ({
        scheduleId: r.scheduleId,
        title: r.title,
        enabled: r.enabled,
        machine: { workspaceId: owner.workspaceId, machineId: r.machineId } as MachineRef,
        ...(r.projectKey
          ? {
              project: {
                workspaceId: owner.workspaceId,
                machineId: r.machineId,
                projectId: r.projectKey,
              } as ProjectRef,
            }
          : {}),
        nextRunAt: schedule.runtimes.find((v) => v.scheduleId === r.scheduleId)?.nextScheduledAt,
      })),
      git: async (target) => {
        if (!account || !('projectId' in target)) throw Error('Project unavailable');
        const project = [...projects.values()].find(
          (p) => p.machineId === target.machineId && p.project.id === target.projectId
        );
        if (!project) throw Error('Project unavailable');
        const r = await runtime.requestLocalProjectGitState(
          project.machineId,
          project.project.id,
          account
        );
        if (!r?.success) throw Error('Git state unavailable');
        const g = r.state;
        return {
          hasRepository: g.git,
          branch: g.git ? g.currentBranch : null,
          baseBranch: g.git ? g.defaultBranch : null,
          dirty: g.git && !g.workingTree.clean,
          ...(g.git ? g.workingTree.upstream : undefined),
        };
      },
      worktrees: visible.allActiveSessions.flatMap((s) => {
        if (!s.isWorktree || s.parentSessionId) return [];
        const project = s.project;
        const root =
          project?.kind === 'local'
            ? projects.get(`${s.machineId}:${project.localProjectId}`)?.project.rootPath
            : null;
        const path = resolveSessionWorkspacePath({
          sessionId: s.id,
          isWorktree: true,
          localProjectRootPath: root,
          repoFullName: s.repoFullName,
          dotlodyPath: resolveMachineDotlodyPath(flock[owner.workspaceId]?.[s.machineId] ?? {}),
          legacyWorkspacePath: visibleMachines.get(s.machineId)?.workspacePaths?.[s.id],
        });
        return path
          ? [
              {
                path,
                branch: s.branchName ?? null,
                locked: null,
                rootSession: eventRefs(owner.workspaceId, s).session,
              },
            ]
          : [];
      }),
      history: (s, id, input, signal) => readPluginHistory(runtime, s, id, input, signal),
      sessions: summaries,
      members: members.map((m) => ({
        userId: m.userId,
        displayName: m.name,
        avatarUrl: m.image ?? undefined,
      })),
      machines: [...visibleMachines.values()].map((m) => ({
        machine: { workspaceId: owner.workspaceId, machineId: String(m.id) } as MachineRef,
        name: m.name || m.id,
        presence: machines.some((x) => x.id === m.id) ? 'online' : 'offline',
        agentConfigs: configs
          .filter((c) => c.machineId === m.id)
          .map((c) => ({ agentConfigId: c.id, cliType: c.cliType, label: c.name })),
      })),
      projects: [...projects.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ machineId, project }) => ({
          name: project.name || project.id,
          project: {
            workspaceId: owner.workspaceId,
            machineId: String(machineId),
            projectId: String(project.id),
          } as ProjectRef,
        })),
      agentRoles: {
        synced,
        items: roles.map((role) => {
          const kind = availability.resolve(role).kind;
          return {
            roleId: role.id,
            name: role.name,
            description: role.description,
            emoji: role.emoji,
            visibility: role.visibility,
            availability: kind === 'available' ? 'ready' : kind,
          };
        }),
      },
    });
    return () => {
      detach();
      reads.publish();
    };
  }, [
    owner,
    runtime,
    reads,
    roles,
    synced,
    availability,
    projects,
    members,
    local,
    revision,
    pending,
    workspaceCatalog,
    schedule.rows,
    schedule.runtimes,
    flock,
    visible.allActiveSessions,
    archivedSessions,
    account,
    visibleMachines,
    configs,
    machines,
  ]);
  const identity = JSON.stringify(
    machines
      .map((m) => ({
        machineId: m.id,
        owner: !!account && account === m.ownerUserId,
      }))
      .sort((a, b) => a.machineId.localeCompare(b.machineId))
  );
  const targets = useMemo(() => JSON.parse(identity) as CatalogMachine[], [identity]);
  useEffect(() => {
    if (!owner || !runtime || runtime.workspaceId !== owner.workspaceId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snapshots = new Map<string, Awaited<ReturnType<typeof readPluginCatalog>>>();
    for (const i of owner.installations()) {
      if (targets.some((t) => t.machineId === i.dev.machineId && t.owner === i.dev.owner)) {
        const group = snapshots.get(i.dev.machineId) ?? [];
        group.push(i);
        snapshots.set(i.dev.machineId, group);
      }
    }
    async function refresh() {
      await Promise.all(
        targets.map(async (target) => {
          try {
            const entries = await readPluginCatalog(
              runtime!.workspaceId,
              target,
              runtime!.requestPlugin,
              (entry, port) =>
                createWorkspacePluginRegistry(entry, port, reads, owner!.storageNamespace)
            );
            if (!active) return;
            snapshots.set(target.machineId, entries);
          } catch {
            if (!active) return;
            snapshots.delete(target.machineId);
          }
          await owner!
            .update([...snapshots.values()].flat())
            .catch((e) => console.error('Plugin reconciliation failed', e));
        })
      );
      if (active) timer = setTimeout(() => void refresh(), 2000);
    }
    void owner
      .update([...snapshots.values()].flat())
      .catch((e) => console.error('Plugin cleanup failed', e));
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [owner, runtime, targets, reads]);
  return (
    <>
      {visible.allActiveSessions
        .filter((s) => s.status?.type === 'requestPermission')
        .map((s) => (
          <PendingInteractionObserver key={s.id} sessionId={s.id} publish={publishPending} />
        ))}
    </>
  );
}
