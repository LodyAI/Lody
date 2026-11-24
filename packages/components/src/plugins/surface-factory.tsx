import { clientDiagnostics } from './client-diagnostics';
import { AttachmentAction } from './attachment-action';
import type { ComposerActionProps } from '@lody/plugin-sdk/client';
import { lodyCommands } from '@lody/plugin-sdk';
import { isNativeAppShell } from '../lib/native-platform';
import { SidebarHoverCard } from '../components/session-info-hover-card';
import { NavButton } from '../components/loro-sidebar';
import { useIsMobile } from '../hooks/use-mobile';
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
    useLodySnapshot: () => ({ status: 'unavailable', reason: 'unknown', refresh: () => {} }),
    usePluginConfig: () => ({
      values: Object.fromEntries(
        Object.entries(entry.dev.manifest.config ?? {})
          .filter(([, f]) => f.type !== 'secret' && f.scope !== 'machine')
          .map(([k, f]) => [
            k,
            entry.inspection?.preferences[k] ?? ('default' in f ? f.default : undefined),
          ])
      ) as never,
      set: async (k, v) => {
        signal.throwIfAborted();
        const field = entry.dev.manifest.config?.[String(k)];
        if (
          !entry.control ||
          typeof k !== 'string' ||
          !field ||
          field.type === 'secret' ||
          field.scope === 'machine' ||
          v === null
        )
          unavailable();
        await entry.control!('configure', { [k]: v as string | number | boolean });
      },
    }),
    useHostCapabilities: () => ({
      platform: getIpcServices() ? 'desktop' : isNativeAppShell() ? 'mobile' : 'web',
      formFactor: matchMedia('(max-width: 700px)').matches ? 'compact' : 'wide',
      containers: { sidebarViews: true, screens: true, sessionPanels: true, projectPages: true },
    }),
    useLody() {
      const nav = hooks.useNavigation();
      const execute = hooks.useExecute();
      return {
        read: hooks.read,
        execute,
        assets,
        readSnapshot: unavailable,
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
    (stack) => clientDiagnostics.report(entry, 'surface_render_crashed', stack)
  );
  return {
    ...createTranscriptSurfaces(entry, signal, bindings),
    sidebar: {
      headerItems: { add: (s) => add('header', s.id, s.Component) },
      footerItems: { add: (s) => add('footer', s.id, s.Component) },
      views: { add: (s) => add('view', s.id, s.Component, s.title) },
      sessionRow: {
        decorate: (s) => {
          if (s.trailing) add('trailing', s.id, s.trailing);
          if (s.hoverCard) add('hover', s.id, s.hoverCard);
        },
      },
    },
    screens: { add: (s) => add('screen', s.id, s.Component, s.title) },
    project: { pages: { add: (s) => add('project', s.id, s.Component, s.title) } },
    session: { panels: { add: (s) => add('panel', s.id, s.Component, s.title) } },
    settings: {
      pages: {
        add: (s) => {
          if (s.binding === 'project') add('projectSettings', s.id, s.Component, s.title);
          else add('settings', s.id, s.Component, s.title);
        },
      },
    },
    composer: {
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
