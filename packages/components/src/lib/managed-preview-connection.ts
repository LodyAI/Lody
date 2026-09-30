import { isQuickTunnelViewerUrl, type PreviewConnection } from '@lody/shared';

export const hasUsableManagedPreviewUrl = (
  connection: PreviewConnection | null | undefined
): connection is PreviewConnection & { status: 'active'; publicUrl: string } =>
  connection?.status === 'active' &&
  Boolean(connection.endpointId && connection.target) &&
  isQuickTunnelViewerUrl(connection.publicUrl);
