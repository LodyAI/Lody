import type { ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { expect, fn, userEvent } from 'storybook/test';
import { useTranslation } from 'react-i18next';
import type { PreviewConnection, SessionId, SessionMeta, MachineId } from '@lody/shared';
import { SessionBrowserPanelView } from '@/components/sessions/session-browser-panel-view';
import { ManagedPreviewSurface } from '@/components/sessions/managed-preview-surface';
import { PublicBrowserSurface } from '@/components/sessions/public-browser-surface';

type ViewProps = ComponentProps<typeof SessionBrowserPanelView>;
type Scenario = Omit<ViewProps, 'children'> & {
  page?: boolean;
  publicBrowser?: boolean;
  remoteMachineName?: string;
  unavailable?: 'machineOffline' | 'ownerRequired' | 'sessionEnded';
};

const logicalUrl = 'http://localhost:5173/dashboard?mode=dev';
const target = {
  protocol: 'http' as const,
  host: 'localhost',
  port: 5173,
  path: '/dashboard?mode=dev',
};
const active: PreviewConnection = {
  status: 'active',
  endpointId: 'storybook-endpoint',
  target,
  updatedAt: 1,
  publicUrl: 'https://storybook-preview.trycloudflare.com/?__lody_preview_token=synthetic',
};
const expired: PreviewConnection = {
  status: 'closed',
  closedReason: 'idle_timeout',
  target,
  updatedAt: 1,
};
const revoked: PreviewConnection = { ...expired, closedReason: 'revoked' };
const failed: PreviewConnection = {
  status: 'failed',
  target,
  updatedAt: 1,
  error: {
    stage: 'create',
    errorCode: 'tunnel_creation_failed',
    message: 'cloudflared download failed (HTTP 404)',
    retryable: true,
  },
};
const toolbar: ViewProps['toolbar'] = {
  address: logicalUrl,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  annotationEnabled: false,
  annotationAvailable: false,
  sharing: false,
  shareAvailable: true,
  hasShareUrl: false,
  busy: false,
  onAddressChange: fn(),
  onRestoreAddress: fn(),
  onNavigate: fn(),
  onBack: fn(),
  onForward: fn(),
  onReload: fn(),
  onStop: fn(),
  onToggleAnnotation: fn(),
  onShare: fn(),
  onStopSharing: fn(),
};
const restore = fn();
const stopSharing = fn();
const remote = { local: false, onRestore: restore, onStopSharing: stopSharing };
const local = { local: true, onRestore: restore, onStopSharing: stopSharing };
const session = {
  id: 'storybook-preview-page' as SessionId,
  machineId: 'storybook-machine' as MachineId,
  userId: 'storybook-user',
  createdAt: '2026-09-23T00:00:00Z',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
} satisfies SessionMeta;

// Only the website inside the real ManagedPreviewSurface is synthetic. It is an
// inert document, never a live localhost service or real Quick Tunnel credential.
const pageHtml =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:0;padding:32px;font:15px system-ui;color:#20242b;background:#fff}small{color:#68717d}h1{font-size:26px;font-weight:600;margin:24px 0 12px}p{max-width:42ch;line-height:1.6}hr{border:0;border-top:1px solid #e5e7eb;margin:24px 0}</style><small>DEVELOPMENT SERVER · STORYBOOK FIXTURE</small><h1>Your local app</h1><p>This page stays available locally even when remote sharing expires.</p><hr><small>Static fixture content. No Cloudflare or development server connection.</small></html>';

function PreviewStory({ page, publicBrowser, unavailable, remoteMachineName, ...props }: Scenario) {
  const { t } = useTranslation();
  const previewStatus = props.previewStatus
    ? {
        ...props.previewStatus,
        remoteMachineName: remoteMachineName ?? props.previewStatus.remoteMachineName,
        unavailableReason: unavailable
          ? t(`sessions.browser.connection.${unavailable}`)
          : props.previewStatus.unavailableReason,
      }
    : undefined;
  return (
    <SessionBrowserPanelView {...props} previewStatus={previewStatus}>
      {publicBrowser ? (
        <PublicBrowserSurface
          browserId="storybook-public-browser"
          navigationRequest={{ id: 1, url: 'https://example.com' }}
          active
          onStateChange={fn()}
          onNavigationRequestConsumed={fn()}
        />
      ) : page ? (
        <Provider>
          <ManagedPreviewSurface
            session={session}
            viewerUrl={logicalUrl}
            logicalUrl={logicalUrl}
            documentHtml={pageHtml}
            annotationEnabled={props.toolbar.annotationEnabled}
            onAnnotationAvailabilityChange={fn()}
            onRuntimeError={fn()}
            onLoadingChange={fn()}
            onBrowserStateChange={fn()}
            onNavigationRequest={fn()}
          />
        </Provider>
      ) : null}
    </SessionBrowserPanelView>
  );
}

const openStatusPopover: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const trigger = canvasElement.querySelector('[data-testid="preview-status-trigger"]');
  if (!(trigger instanceof HTMLElement)) throw new Error('Expected preview status trigger');
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
};

const meta = {
  title: 'Sessions/Browser Preview/States',
  component: PreviewStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Production Browser presentation with controlled state. The status icon and popover use the real PreviewConnectionStatus component; the page is rendered by the real ManagedPreviewSurface using an inert static HTML fixture. No tunnel, auth or native Electron engine is exercised. Controller stories cover Enter and restore separately. Theme and locale can be changed from the toolbar.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    toolbar,
    remoteMachineName: 'Build Mac',
    onDismissError: fn(),
  },
} satisfies Meta<typeof PreviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { toolbar: { ...toolbar, address: '', shareAvailable: false } },
};
export const CandidateAvailable: Story = {
  args: { suggestedAddress: logicalUrl, toolbar: { ...toolbar, shareAvailable: false } },
};
export const ResolvingMachine: Story = {
  args: { navigationPhase: 'resolving-machine', toolbar: { ...toolbar, busy: true } },
};
export const OpeningLocal: Story = {
  args: {
    remoteMachineName: undefined,
    navigationPhase: 'opening-local',
    toolbar: { ...toolbar, busy: true },
  },
};
export const ConnectingRemote: Story = {
  args: {
    navigationPhase: 'creating-tunnel',
    previewStatus: { ...remote, busy: true },
    toolbar: { ...toolbar, busy: true },
  },
};
export const CheckingRemote: Story = { args: { previewStatus: { ...remote, checking: true } } };
export const RemoteNotOpen: Story = { args: { previewStatus: remote } };
export const RemoteConnected: Story = {
  args: {
    page: true,
    previewStatus: { ...remote, connection: active, hasShareUrl: true },
    toolbar: { ...toolbar, hasShareUrl: true },
  },
};
export const RemoteExpired: Story = {
  args: { previewStatus: { ...remote, connection: expired } },
};
export const RemoteRevoked: Story = { args: { previewStatus: { ...remote, connection: revoked } } };
export const RemoteClosed: Story = {
  args: { previewStatus: { ...remote, connection: { ...expired, closedReason: 'runtime_lost' } } },
};
export const RemoteFailed: Story = { args: { previewStatus: { ...remote, connection: failed } } };
export const StatusQueryFailed: Story = {
  args: { previewStatus: { ...remote, error: 'Remote preview request timed out.' } },
};
export const RestoreInProgress: Story = {
  args: {
    previewStatus: { ...remote, connection: expired, busy: true },
    toolbar: { ...toolbar, busy: true },
  },
};
export const MachineOffline: Story = {
  args: { unavailable: 'machineOffline', previewStatus: { ...remote, connection: expired } },
};
export const OwnerRequired: Story = {
  args: { unavailable: 'ownerRequired', previewStatus: { ...remote, connection: expired } },
};
export const ArchivedSession: Story = {
  args: { unavailable: 'sessionEnded', previewStatus: { ...remote, connection: expired } },
};
export const LocalDirect: Story = {
  args: { page: true, remoteMachineName: undefined, previewStatus: local, toolbar },
};
export const LocalSharing: Story = {
  args: {
    ...LocalDirect.args,
    previewStatus: { ...local, connection: active, hasShareUrl: true },
    toolbar: { ...toolbar, hasShareUrl: true },
  },
};
export const LocalShareCreating: Story = {
  args: {
    ...LocalDirect.args,
    previewStatus: { ...local, connection: { status: 'creating', target, updatedAt: 1 } },
    toolbar: { ...toolbar, sharing: true },
  },
};
export const LocalShareExpired: Story = {
  args: { ...LocalDirect.args, previewStatus: { ...local, connection: expired } },
};
export const LocalShareRevoked: Story = {
  args: { ...LocalDirect.args, previewStatus: { ...local, connection: revoked } },
};
export const LocalShareFailed: Story = {
  args: {
    ...LocalDirect.args,
    previewStatus: { ...local, connection: failed },
    error: failed.error!.message,
  },
};
export const LocalChecking: Story = {
  args: { ...LocalDirect.args, previewStatus: { ...local, checking: true } },
};
export const PageLoading: Story = {
  args: {
    ...RemoteConnected.args,
    toolbar: { ...toolbar, hasShareUrl: true, loading: true },
  },
};
export const AnnotationAvailable: Story = {
  args: { ...LocalDirect.args, toolbar: { ...toolbar, annotationAvailable: true } },
  parameters: {
    docs: {
      description: {
        story:
          'Toolbar capability state only. The inert page fixture does not implement annotation messages.',
      },
    },
  },
};
export const AnnotationEnabled: Story = {
  args: {
    ...AnnotationAvailable.args,
    toolbar: { ...toolbar, annotationAvailable: true, annotationEnabled: true },
  },
  parameters: AnnotationAvailable.parameters,
};
export const HistoryAvailable: Story = {
  args: { ...LocalDirect.args, toolbar: { ...toolbar, canGoBack: true, canGoForward: true } },
};
export const DownloadFailed: Story = {
  args: {
    previewStatus: {
      ...remote,
      connection: failed,
      hasShareUrl: false,
      error: failed.error!.message,
    },
    error: failed.error!.message,
  },
};
export const LongDiagnostic: Story = {
  args: {
    previewStatus: {
      ...remote,
      connection: failed,
      error:
        'cloudflared readiness failed: the origin server at http://localhost:5173/dashboard?mode=dev did not respond; connection refused. Start the development server, then restore preview.',
    },
  },
};
export const PublicBrowserUnsupported: Story = {
  args: { publicBrowser: true, toolbar: { ...toolbar, address: 'https://example.com' } },
};
export const MobileExpired: Story = {
  args: RemoteExpired.args,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  decorators: [
    (Story) => (
      <div style={{ width: 390, maxWidth: '100vw', height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
};
export const DarkConnected: Story = { args: RemoteConnected.args, globals: { theme: 'dark' } };
export const ChineseExpired: Story = { args: RemoteExpired.args, globals: { locale: 'zh_CN' } };

export const StatusPopoverRemote: Story = {
  args: RemoteConnected.args,
  play: openStatusPopover,
};
export const StatusPopoverLocalExpired: Story = {
  args: LocalShareExpired.args,
  play: openStatusPopover,
};
export const StatusPopoverNarrow: Story = {
  args: RemoteExpired.args,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  decorators: [
    (Story) => (
      <div style={{ width: 390, maxWidth: '100vw', height: '100vh' }}>
        <Story />
      </div>
    ),
  ],
  play: openStatusPopover,
};
export const StatusPopoverDark: Story = {
  args: RemoteConnected.args,
  globals: { theme: 'dark' },
  play: openStatusPopover,
};
export const StatusPopoverChinese: Story = {
  args: RemoteExpired.args,
  globals: { locale: 'zh_CN' },
  play: openStatusPopover,
};
