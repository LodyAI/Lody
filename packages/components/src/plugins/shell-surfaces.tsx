import { commands } from '../lib/commands/registry';
import { useVisibleLocalProjects } from '../hooks/use-visible-local-projects';
import { getLocalProjectVisibilityKey } from '../lib/visible-local-project-index';
import { Link, useParams, useRouter } from '@tanstack/react-router';
import { usePluginNavigation } from './routed-navigation';

import { shellIdentity } from './shell-generation';
import { ContextMenu } from '@lody/ui/context-menu';

import {
  useEffect,
  useMemo,
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import {
  ClientHostProvider,
  type ClientHostBindings,
  type SidebarItemProps,
  type SessionSummary,
  type WorkspaceRef,
  type SessionRowSlotProps,
} from '@lody/plugin-sdk/client';
import { SurfaceErrorBoundary } from './surface-error-boundary';
export { SurfaceErrorBoundary };
type Slot = {
  id: string;
  identity: AbortSignal;
  source: string;
  key: string;
  workspaceId: string;
  kind: string;
  title?: string;
  order?: number;
  machineId?: string;
  pluginId?: string;
  version?: string;
  render: (props: unknown, onCrash?: (stack: string) => void) => ReactNode;
};
let slots: Slot[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};
const snapshot = () => slots;
export function scopedSlots(
  workspaceId: string,
  source: string,
  bindings: ClientHostBindings,
  signal: AbortSignal,
  machineId?: string,
  report?: (stack: string) => void,
  pluginId?: string,
  version?: string
) {
  const owned = new Set<Slot>();
  signal.addEventListener(
    'abort',
    () => {
      slots = slots.filter((s) => !owned.has(s));

      owned.clear();
      notify();
    },
    { once: true }
  );
  return <P extends object>(
    kind: string,
    id: string,
    C: ComponentType<P>,
    title?: string,
    order?: number
  ) => {
    signal.throwIfAborted();
    const key = JSON.stringify([source, id, kind]);
    const slot = {
      id,
      identity: shellIdentity(signal, JSON.stringify([kind, id])),
      source,
      workspaceId,
      machineId,
      pluginId,
      version,
      key,
      kind,
      title,
      order,
      render: (props: unknown, onCrash?: (stack: string) => void) => (
        <SurfaceErrorBoundary
          key={key}
          onCrash={(stack) => {
            report?.(stack);
            onCrash?.(stack);
          }}
        >
          <ClientHostProvider value={bindings}>
            <C {...(props as P)} />
          </ClientHostProvider>
        </SurfaceErrorBoundary>
      ),
    };
    owned.add(slot);
    slots = [...slots, slot].sort((a, b) => (a.key < b.key ? -1 : 1));
    notify();
  };
}
export function PluginRowDecorations(props: SessionRowSlotProps & { kind: string }) {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter((s) => s.workspaceId === props.workspace.workspaceId && s.kind === props.kind)
    .map((s) => {
      if (props.session.businessKey === undefined || s.pluginId === props.session.createdByPluginId)
        return s.render(props);
      const { businessKey: _, ...session } = props.session;
      return s.render({ ...props, session });
    });
}
function ScreenLinks({ list }: { list: Slot[] }) {
  const { workspaceName } = useParams({ strict: false });
  const router = useRouter();
  const { t } = useTranslation();
  useEffect(() => {
    if (!workspaceName) return;
    const unregister = list.map((s) =>
      commands.register({
        id: `plugin-screen:${s.key}`,
        title: s.title ?? s.id,
        category: 'Workspace',
        keybindings: [],
        run: () =>
          router.navigate({
            to: '/$workspaceName/p/$pluginId/$screenId',
            params: { workspaceName, pluginId: s.pluginId!, screenId: s.id },
          }),
      })
    );
    return () => unregister.forEach((remove) => remove());
  }, [list, router, workspaceName]);
  if (!workspaceName) return null;
  return (
    <nav aria-label={t('plugins.apps')}>
      <h3>{t('plugins.apps')}</h3>
      {[...list]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((s) => (
          <Link
            key={s.key}
            to="/$workspaceName/p/$pluginId/$screenId"
            params={{ workspaceName, pluginId: s.pluginId!, screenId: s.id }}
            activeProps={{ 'aria-current': 'page', style: { fontWeight: 'bold' } }}
          >
            {s.title}
          </Link>
        ))}
    </nav>
  );
}
export function PluginSidebar({
  workspaceId,
  children,
  activeSessionId,
}: {
  activeSessionId?: string | null;
  workspaceId?: string;
  children: ReactNode;
}) {
  const slots = useSyncExternalStore(subscribe, snapshot, snapshot);
  const list = useMemo(
    () => slots.filter((s) => s.workspaceId === workspaceId),
    [slots, workspaceId]
  );
  const screens = useMemo(() => list.filter((s) => s.order !== undefined), [list]);
  const [selected, select] = useState<AbortSignal>();
  const { t } = useTranslation();
  const views = list.filter((s) => s.kind === 'view');
  const active = views.find((s) => s.identity === selected);
  const readActive = () =>
    workspaceId && activeSessionId
      ? rows.get(workspaceId)?.get(activeSessionId)?.session
      : undefined;
  const activeSession = useSyncExternalStore(subscribe, readActive, readActive);
  const props: SidebarItemProps = { workspace: { workspaceId } as WorkspaceRef, activeSession };
  return (
    <SidebarWorkspace.Provider value={workspaceId}>
      {list.filter((s) => s.kind === 'header').map((s) => s.render(props))}
      {screens.length > 0 && <ScreenLinks list={screens} />}
      {views.length > 0 && (
        <>
          <Button aria-pressed={!active} onClick={() => select(undefined)}>
            {t('plugins.sidebar.default', 'Default')}
          </Button>
          {views.map((s) => (
            <Button key={s.key} aria-pressed={active === s} onClick={() => select(s.identity)}>
              {s.title}
            </Button>
          ))}
        </>
      )}
      {active ? active.render(props, () => select(undefined)) : children}
      {list.filter((s) => s.kind === 'footer').map((s) => s.render(props))}
      {list.some((s) => s.kind === 'statusItem') && (
        <footer aria-label="Plugin status">
          {list
            .filter((s) => s.kind === 'statusItem')
            .map((s) => s.render({ workspace: props.workspace }))}
        </footer>
      )}
    </SidebarWorkspace.Provider>
  );
}

function ProjectPageHeader({
  slot,
  pages,
  project,
}: {
  slot: Slot;
  pages: Slot[];
  project: { machineId: string; projectId: string };
}) {
  const { workspaceName } = useParams({ strict: false });
  const { projects } = useVisibleLocalProjects();
  const route = usePluginNavigation();
  const projectName =
    projects.get(getLocalProjectVisibilityKey(project.machineId, project.projectId))?.project
      .name ?? project.projectId;
  return (
    <header>
      {projectName} /{' '}
      <select
        aria-label={slot.title}
        value={slot.key}
        onChange={(e) => {
          const next = pages.find((p) => p.key === e.currentTarget.value);
          if (next && workspaceName) route(next.pluginId!, next.id, 'project', {}, project);
        }}
      >
        {pages.map((p) => (
          <option key={p.key} value={p.key}>
            {p.title}
          </option>
        ))}
      </select>
    </header>
  );
}
export function RoutedSurface({
  workspaceId,
  pluginId,
  id,
  kind,
  params,
  target = {},
  fallback = null,
}: {
  workspaceId: string;
  pluginId: string;
  id: string;
  kind: string;
  params: Record<string, string>;
  target?: object;
  fallback?: ReactNode;
}) {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  const project =
    'project' in target ? (target.project as { machineId: string; projectId: string }) : undefined;
  const machineId =
    project?.machineId ??
    ('session' in target ? (target.session as { machineId: string }).machineId : undefined);
  const candidates = all.filter(
    (s) =>
      s.workspaceId === workspaceId &&
      s.kind === kind &&
      (!machineId || !s.machineId || s.machineId === machineId)
  );
  const slot = candidates.find((s) => s.pluginId === pluginId && s.id === id);
  if (!slot) return fallback;
  return (
    <>
      {project && <ProjectPageHeader slot={slot} pages={candidates} project={project} />}
      {slot.render({ workspace: { workspaceId }, ...target, params })}
    </>
  );
}
const SidebarWorkspace = createContext<string | undefined>(undefined);
const rows = new Map<string, ReadonlyMap<string, SessionSummary>>();
export function publishPluginSidebarRows(workspace: string, values: readonly SessionSummary[]) {
  const indexed = new Map(values.map((s) => [s.session.sessionId, s]));
  rows.set(workspace, indexed);
  notify();
  return () => {
    if (rows.get(workspace) === indexed) {
      rows.delete(workspace);
      notify();
    }
  };
}
export function NativePluginRow({
  sessionId,
  active,
  kind,
}: {
  sessionId: string;
  active: boolean;
  kind: string;
}) {
  const workspaceId = useContext(SidebarWorkspace);
  const read = () => (workspaceId ? rows.get(workspaceId)?.get(sessionId) : undefined);
  const session = useSyncExternalStore(subscribe, read, read);
  return session ? (
    <PluginRowDecorations
      workspace={{ workspaceId } as WorkspaceRef}
      session={session}
      active={active}
      kind={kind}
    />
  ) : null;
}
export function PluginSessionActions({
  session,
  turnId,
}: {
  session: import('@lody/plugin-sdk').SessionRef;
  turnId?: string;
}) {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) =>
        s.workspaceId === session.workspaceId &&
        s.kind === (turnId === undefined ? 'sessionHeader' : 'messageAction')
    )
    .map((s) => s.render({ session, turnId }));
}
export function PluginComposerActions(
  props: import('@lody/plugin-sdk/client').ComposerActionProps
) {
  const route = usePluginNavigation();
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) =>
        s.workspaceId === props.session.workspaceId &&
        (!s.machineId || s.machineId === props.session.machineId) &&
        (s.kind === 'action' || s.kind === 'attachment' || s.kind === 'panel')
    )
    .map((s) =>
      s.kind === 'panel' ? (
        <Button key={s.key} onClick={() => route(s.pluginId!, s.id, 'panel', {}, props.session)}>
          {s.title}
        </Button>
      ) : (
        s.render(props)
      )
    );
}

export function PluginProjectMenu({
  machineId,
  projectId,
}: {
  machineId: string;
  projectId: string;
}) {
  const route = usePluginNavigation();
  const workspaceId = useContext(SidebarWorkspace);
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) =>
        s.workspaceId === workspaceId &&
        s.kind === 'project' &&
        (!s.machineId || s.machineId === machineId)
    )
    .map((s) => (
      <ContextMenu.Item
        key={s.key}
        onClick={() => route(s.pluginId!, s.id, 'project', {}, { machineId, projectId })}
      >
        {s.title}
      </ContextMenu.Item>
    ));
}
export function ProjectPluginSettings(props: {
  workspaceId: string;
  machineId: string;
  projectId: string;
}) {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) =>
        s.workspaceId === props.workspaceId &&
        s.machineId === props.machineId &&
        s.kind === 'projectSettings'
    )
    .map((s) => (
      <section key={s.key}>
        <h3>{s.title}</h3>
        {s.render({ workspace: { workspaceId: props.workspaceId }, project: props, params: {} })}
      </section>
    ));
}
export function PluginInstallationSettings({
  workspacePages = true,
  page,
  entry,
}: {
  page?: string;
  workspacePages?: boolean;
  entry: import('./client-host-provider').ClientCatalogInstallation;
}) {
  const source = JSON.stringify([entry.pluginId, entry.sourceKey, entry.digest]);
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) =>
        s.workspaceId === entry.workspaceId &&
        (!page || s.id === page) &&
        ((s.kind === 'settings' &&
          entry.sourceKey !== 'workspace' &&
          s.source === source &&
          s.machineId === entry.dev.machineId) ||
          (workspacePages && s.kind === 'workspaceSettings' && s.pluginId === entry.pluginId))
    )
    .map((s) => (
      <section key={s.key}>
        <h3>{s.title}</h3>
        {s.render({
          workspace: { workspaceId: entry.workspaceId },
          ...(s.kind === 'settings'
            ? { machine: { workspaceId: entry.workspaceId, machineId: entry.dev.machineId } }
            : {}),
          pluginId: entry.pluginId,
          version: s.version ?? entry.dev.manifest.version,
        })}
      </section>
    ));
}

export function usePluginSlot(
  workspaceId: string | undefined,
  pluginId: string,
  kind: string,
  id: string,
  machineId?: string
) {
  return useSyncExternalStore(subscribe, snapshot, snapshot).find(
    (s) =>
      s.workspaceId === workspaceId &&
      s.pluginId === pluginId &&
      s.kind === kind &&
      s.id === id &&
      (!machineId || s.machineId === machineId)
  );
}
