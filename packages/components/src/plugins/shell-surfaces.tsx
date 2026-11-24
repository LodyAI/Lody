import { shellIdentity } from './shell-generation';
import { ContextMenu } from '@lody/ui/context-menu';
import { Dialog } from '../ui/dialog';
import {
  createContext,
  useContext,
  Component,
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
export class SurfaceErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; onCrash?: (stack: string) => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('surface_render_crashed', error, info.componentStack);
    this.props.onCrash?.(info.componentStack ?? error.message);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
type Slot = {
  identity: AbortSignal;
  source: string;
  key: string;
  workspaceId: string;
  kind: string;
  title?: string;
  machineId?: string;
  pluginId?: string;
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
  pluginId?: string
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
  return <P extends object>(kind: string, id: string, C: ComponentType<P>, title?: string) => {
    signal.throwIfAborted();
    const key = JSON.stringify([source, id, kind]);
    const slot = {
      identity: shellIdentity(signal, JSON.stringify([kind, id])),
      source,
      workspaceId,
      machineId,
      pluginId,
      key,
      kind,
      title,
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
export function PluginSidebar({
  workspaceId,
  children,
  activeSessionId,
}: {
  activeSessionId?: string | null;
  workspaceId?: string;
  children: ReactNode;
}) {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot).filter(
    (s) => s.workspaceId === workspaceId
  );
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
    </SidebarWorkspace.Provider>
  );
}

const screenEvents = new Set<() => void>();
let screen:
  | { identity: AbortSignal; target: object; params: Readonly<Record<string, string>> }
  | undefined;
const screenSnapshot = () => screen;
const watchScreen = (fn: () => void) => {
  screenEvents.add(fn);
  return () => {
    screenEvents.delete(fn);
  };
};
function closeScreen() {
  changeScreen(undefined);
}
function changeScreen(value: typeof screen) {
  screen?.identity.removeEventListener('abort', closeScreen);
  screen = value;
  screen?.identity.addEventListener('abort', closeScreen, { once: true });
  screenEvents.forEach((f) => f());
}
export function openPluginScreen(
  workspaceId: string,
  source: string,
  id: string,
  params: Readonly<Record<string, string>> = {},
  kind = 'screen',
  target: object = {}
) {
  const slot = slots.find(
    (s) => s.workspaceId === workspaceId && s.key === JSON.stringify([source, id, kind])
  );
  if (!slot) throw Error('Plugin screen unavailable');
  changeScreen({
    identity: slot.identity,
    params: structuredClone(params),
    target: structuredClone(target),
  });
}
export function PluginScreenOutlet({ workspaceId }: { workspaceId: string }) {
  const current = useSyncExternalStore(watchScreen, screenSnapshot, screenSnapshot);
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { t } = useTranslation();
  const slot = list.find((s) => s.identity === current?.identity && s.workspaceId === workspaceId);
  if (!current || !slot) return null;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) changeScreen(undefined);
      }}
    >
      <Dialog.Content>
        <Dialog.Header>
          <Dialog.Title>{slot.title}</Dialog.Title>
        </Dialog.Header>
        <Button onClick={() => changeScreen(undefined)}>{t('common.close', 'Close')}</Button>
        {slot.render({
          workspace: { workspaceId },
          ...current.target,
          params: current.params,
        })}
      </Dialog.Content>
    </Dialog.Root>
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
export function PluginComposerActions(
  props: import('@lody/plugin-sdk/client').ComposerActionProps
) {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) =>
        s.workspaceId === props.session.workspaceId &&
        (!s.machineId || s.machineId === props.session.machineId) &&
        (s.kind === 'action' || s.kind === 'attachment' || s.kind === 'panel')
    )
    .map((s) =>
      s.kind === 'panel' ? (
        <Button
          key={s.key}
          onClick={() =>
            changeScreen({
              identity: s.identity,
              params: {},
              target: { session: props.session, project: props.project },
            })
          }
        >
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
  const workspaceId = useContext(SidebarWorkspace);
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) =>
        s.workspaceId === workspaceId &&
        s.machineId === machineId &&
        (s.kind === 'project' || s.kind === 'projectSettings')
    )
    .map((s) => (
      <ContextMenu.Item
        key={s.key}
        onClick={() =>
          changeScreen({
            identity: s.identity,
            params: {},
            target: { project: { workspaceId, machineId, projectId } },
          })
        }
      >
        {s.title}
      </ContextMenu.Item>
    ));
}
export function PluginInstallationSettings({
  entry,
}: {
  entry: import('./client-host-provider').ClientCatalogInstallation;
}) {
  const source = JSON.stringify([entry.pluginId, entry.sourceKey, entry.digest]);
  return useSyncExternalStore(subscribe, snapshot, snapshot)
    .filter(
      (s) => s.workspaceId === entry.workspaceId && s.source === source && s.kind === 'settings'
    )
    .map((s) =>
      s.render({
        workspace: { workspaceId: entry.workspaceId },
        machine: { workspaceId: entry.workspaceId, machineId: entry.dev.machineId },
        pluginId: entry.pluginId,
        version: entry.dev.manifest.version,
      })
    );
}
