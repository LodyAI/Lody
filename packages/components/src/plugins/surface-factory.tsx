import { pluginUi } from './plugin-ui';
import { clientDiagnostics } from './client-diagnostics';
import { composerContributions } from './composer-contributions';
import { AttachmentAction } from './attachment-action';
import type { ComposerActionProps } from '@lody/plugin-sdk/client';
import { lodyCommands } from '@lody/plugin-sdk';
import { isNativeAppShell } from '../lib/native-platform';
import { SidebarHoverCard } from '../components/session-info-hover-card';
import { NavButton } from '../components/loro-sidebar';
import { useIsMobile, useIsCompactDesktop } from '../hooks/use-mobile';
import type { ClientHostBindings, WorkspaceRef } from '@lody/plugin-sdk/client';
import { getIpcServices } from '../lib/electron-ipc-client';
import { scopedSlots, PluginRowDecorations, openPluginScreen } from './shell-surfaces';
import type { SurfaceFactory } from './workspace-plugin-registry';
import { activatePluginTheme } from './appearance';
import { createTranscriptSurfaces } from './transcript-surfaces';
const unavailable = (): never => {
  throw Error('Plugin operation unavailable on this host');
};
export const createProductionSurfaces: SurfaceFactory = (entry, signal, hooks, assets) => {
  const contributions = composerContributions(entry.workspaceId, entry.pluginId, signal);
  const source = JSON.stringify([entry.pluginId, entry.sourceKey, entry.digest]);
  const workspace = { workspaceId: entry.workspaceId } as WorkspaceRef;

  const bindings: ClientHostBindings = {
    ...hooks,
    SidebarRow: ({ icon, label, trailing, onClick, selected }) => (
      <NavButton
        isMobile={useIsMobile()}
        active={!!selected}
        onClick={onClick}
        icon={icon}
        label={label}
        action={trailing}
      />
    ),
    SessionRow: ({ session, selected = false, leading, onClick }) => (
      <SidebarHoverCard
        content={
          <PluginRowDecorations
            kind="hover"
            workspace={workspace}
            session={session}
            active={selected}
          />
        }
      >
        <NavButton
          isMobile={useIsMobile()}
          active={selected}
          onClick={onClick}
          icon={leading}
          label={session.title}
          action={
            <PluginRowDecorations
              kind="trailing"
              workspace={workspace}
              session={session}
              active={selected}
            />
          }
        />
      </SidebarHoverCard>
    ),
    useUnstableLodySnapshot: hooks.useUnstableLodySnapshot,
    usePluginConfig: (project) => {
      if (
        project &&
        (project.workspaceId !== entry.workspaceId || project.machineId !== entry.dev.machineId)
      )
        throw Error('Invalid project configuration target');
      return {
        values: Object.fromEntries(
          Object.entries(entry.dev.manifest.config ?? {})
            .filter(
              ([, f]) =>
                f.type !== 'secret' && f.scope !== 'machine' && (f.scope !== 'project' || !!project)
            )
            .map(([k, f]) => [
              k,
              (f.scope === 'project'
                ? entry.inspection?.projectPreferences?.[project!.projectId]?.[k]
                : entry.inspection?.preferences[k]) ?? ('default' in f ? f.default : undefined),
            ])
        ) as never,
        set: async (k, v) => {
          signal.throwIfAborted();
          if (entry.configureClient) {
            if (typeof k !== 'string' || v === null) unavailable();
            await entry.configureClient({ [String(k)]: v as string | number | boolean });
            return;
          }
          const field = entry.dev.manifest.config?.[String(k)];
          if (
            !entry.control ||
            typeof k !== 'string' ||
            !field ||
            field.type === 'secret' ||
            field.scope === 'machine' ||
            (field.scope === 'project' && !project) ||
            v === null
          )
            unavailable();
          await entry.control!(
            'configure',
            { [k]: v as string | number | boolean },
            field?.scope === 'project' ? project?.projectId : undefined
          );
        },
      };
    },
    useHostCapabilities() {
      const mobileLayout = useIsMobile();
      const compactDesktop = useIsCompactDesktop();
      return {
        platform: getIpcServices() ? 'desktop' : isNativeAppShell() ? 'mobile' : 'web',
        formFactor: mobileLayout || compactDesktop ? 'compact' : 'wide',
        containers: {
          sidebarViews: !isNativeAppShell(),
          screens: true,
          sessionPanels: true,
          projectPages: true,
        },
      };
    },
    useLody() {
      const nav = hooks.useNavigation();
      const execute = hooks.useExecute();
      return {
        ui: pluginUi(entry.dev.manifest.title, signal),
        storage: hooks.storage,
        read: hooks.read,
        execute,
        assets,
        unstable: hooks.unstable,
        sessions: {
          open: nav.openSession,
          create: (target, r) => execute(target, lodyCommands.sessionCreate, r),
          send: (session, input) => execute(session, lodyCommands.sessionSend, input),
          respondInteraction: (session, input) =>
            execute(session, lodyCommands.sessionRespondInteraction, input),
          requestStop: (session) => execute(session, lodyCommands.sessionStop),
          requestArchive: (session) => execute(session, lodyCommands.sessionArchive),
        },
        drafts: { open: nav.openDraft, append: nav.appendDraft },
        panels: {
          openSession: (session, id, params) => {
            signal.throwIfAborted();
            if (
              session.workspaceId !== entry.workspaceId ||
              session.machineId !== entry.dev.machineId
            )
              unavailable();
            nav.openSession(session);
            openPluginScreen(entry.workspaceId, source, id, params, 'panel', { session });
          },
        },
        screens: {
          open: (w, id, params) => {
            signal.throwIfAborted();
            if (w.workspaceId !== entry.workspaceId) unavailable();
            openPluginScreen(w.workspaceId, source, id, params);
          },
        },
        pages: {
          openProject: (project, id, params) => {
            signal.throwIfAborted();
            if (
              project.workspaceId !== entry.workspaceId ||
              project.machineId !== entry.dev.machineId
            )
              unavailable();
            openPluginScreen(entry.workspaceId, source, id, params, 'project', { project });
          },
        },
        themes: {
          activate: (id) => {
            signal.throwIfAborted();
            activatePluginTheme(entry, id);
          },
        },
      };
    },
  };
  const add = scopedSlots(
    entry.workspaceId,
    source,
    bindings,
    signal,
    entry.dev.machineId,
    (stack) => clientDiagnostics.report(entry, 'surface_render_crashed', stack),
    entry.pluginId
  );
  const transcript = createTranscriptSurfaces(entry, signal, bindings);
  return {
    ...transcript,
    messages: {...transcript.messages, actions: {add: s=>add('messageAction',s.id,s.Component)}},
    statusBar: {items: {add: s=>isNativeAppShell() ? clientDiagnostics.report(entry,'capability_unavailable_on_platform','statusBar.items:'+s.id) : add('statusItem',s.id,s.Component)}},
    sidebar: {
      headerItems: { add: (s) => add('header', s.id, s.Component) },
      footerItems: { add: (s) => add('footer', s.id, s.Component) },
      views: {
        add: (s) =>
          isNativeAppShell()
            ? clientDiagnostics.report(
                entry,
                'capability_unavailable_on_platform',
                `sidebar.views:${s.id}`
              )
            : add('view', s.id, s.Component, s.title),
      },
      sessionRow: {
        decorate: (s) => {
          if (s.trailing) add('trailing', s.id, s.trailing);
          if (s.hoverCard) add('hover', s.id, s.hoverCard);
        },
      },
    },
    screens: { add: (s) => add('screen', s.id, s.Component, s.title) },
    project: { pages: { add: (s) => add('project', s.id, s.Component, s.title) } },
    session: {headerActions: {add: s=>add('sessionHeader',s.id,s.Component)}, panels: { add: (s) => add('panel', s.id, s.Component, s.title) } },
    settings: {
      pages: {
        add: (s) => {
          if (s.binding === 'project') add('projectSettings', s.id, s.Component, s.title);
          else add('settings', s.id, s.Component, s.title);
        },
      },
    },
    commands: contributions.commands,
    composer: {
      slashCommands: contributions.slashCommands,
      beforeSend: contributions.beforeSend,
      actions: { add: (s) => add('action', s.id, s.Component, s.title) },
      attachments: {
        add: (source, options) =>
          add('attachment', source.id, (props: ComposerActionProps) => (
            <AttachmentAction
              {...props}
              signal={signal}
              source={source}
              port={hooks.port}
              renderItem={options?.renderItem}
            />
          )),
      },
    },
  };
};
