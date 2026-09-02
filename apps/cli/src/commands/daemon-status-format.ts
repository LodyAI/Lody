import chalk from 'chalk';
import type {
  CliBackendAuthorization,
  CliBackendConnection,
  CliRuntimeConnectivity,
  CliRuntimeState,
  CliWorkspaceBackendConnection,
} from '@lody/shared';

export const DAEMON_CONNECTION_ERROR_AFTER_MS = 60_000;

export type DaemonStatusPalette = {
  success: (value: string) => string;
  warning: (value: string) => string;
  error: (value: string) => string;
  muted: (value: string) => string;
};

const defaultPalette: DaemonStatusPalette = {
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  muted: chalk.gray,
};

type FormatDaemonBackendStatusOptions = {
  nowMs?: number;
  connectionErrorAfterMs?: number;
  palette?: DaemonStatusPalette;
};

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

function formatAuthorization(
  authorization: CliBackendAuthorization | 'unknown',
  palette: DaemonStatusPalette
): string {
  switch (authorization) {
    case 'authorized':
      return palette.success(authorization);
    case 'pending':
      return palette.warning(authorization);
    case 'rejected':
      return palette.error(authorization);
    case 'unknown':
      return palette.muted(authorization);
    default: {
      const unreachable: never = authorization;
      return unreachable;
    }
  }
}

function formatConnection(
  connection: CliBackendConnection | CliWorkspaceBackendConnection | 'unknown',
  notConnectedSinceMs: number | undefined,
  options: Required<FormatDaemonBackendStatusOptions>
): { formatted: string; unavailableFor: string | null; stale: boolean } {
  if (connection === 'connected') {
    return { formatted: options.palette.success(connection), unavailableFor: null, stale: false };
  }
  if (connection === 'unknown') {
    return { formatted: options.palette.muted(connection), unavailableFor: null, stale: false };
  }

  const elapsedMs =
    notConnectedSinceMs === undefined ? null : Math.max(0, options.nowMs - notConnectedSinceMs);
  const unavailableFor = elapsedMs === null ? null : formatElapsed(elapsedMs);
  const label = unavailableFor === null ? connection : `${connection} (${unavailableFor})`;
  const stale = elapsedMs !== null && elapsedMs >= options.connectionErrorAfterMs;
  const tone =
    stale || connection === 'disconnected' ? options.palette.error : options.palette.warning;
  return { formatted: tone(label), unavailableFor, stale };
}

export function formatDaemonConnectivityStatus(
  connectivity: CliRuntimeConnectivity,
  palette: DaemonStatusPalette = defaultPalette
): string {
  switch (connectivity) {
    case 'online':
      return palette.success(connectivity);
    case 'reconnecting':
      return palette.warning(connectivity);
    case 'offline':
      return palette.error(connectivity);
    default: {
      const unreachable: never = connectivity;
      return unreachable;
    }
  }
}

export function formatDaemonBackendStatus(
  runtimeState: CliRuntimeState,
  options: FormatDaemonBackendStatusOptions = {}
): string[] {
  const resolvedOptions: Required<FormatDaemonBackendStatusOptions> = {
    nowMs: options.nowMs ?? Date.now(),
    connectionErrorAfterMs: options.connectionErrorAfterMs ?? DAEMON_CONNECTION_ERROR_AFTER_MS,
    palette: options.palette ?? defaultPalette,
  };
  const authorization = runtimeState.backend?.authorization ?? 'unknown';
  const backendConnection = formatConnection(
    runtimeState.backend?.connection ?? 'unknown',
    runtimeState.connectionAges?.backendNotConnectedSinceMs,
    resolvedOptions
  );
  const lines = [
    `  Backend Auth: ${formatAuthorization(authorization, resolvedOptions.palette)}`,
    `  Backend Link: ${backendConnection.formatted}`,
  ];
  if (backendConnection.stale && backendConnection.unavailableFor) {
    lines.push(
      resolvedOptions.palette.error(
        `  Backend Error: not connected for ${backendConnection.unavailableFor}`
      )
    );
  }

  if (!runtimeState.connectedWorkspaces) {
    lines.push(`  Workspaces:   ${resolvedOptions.palette.muted('unavailable')}`);
    return lines;
  }

  lines.push(`  Workspaces:   ${runtimeState.connectedWorkspaces.length}`);
  for (const workspace of runtimeState.connectedWorkspaces) {
    const label = workspace.slug ? `${workspace.name} (${workspace.slug})` : workspace.name;
    const connection = formatConnection(
      workspace.backendConnection,
      runtimeState.connectionAges?.workspaceNotConnectedSinceMs?.[workspace.id],
      resolvedOptions
    );
    lines.push(`    - ${label} [${workspace.role}]`);
    lines.push(`      ID: ${workspace.id}`);
    lines.push(`      Backend: ${connection.formatted}`);
    if (connection.stale && connection.unavailableFor) {
      lines.push(
        resolvedOptions.palette.error(`      Error: not connected for ${connection.unavailableFor}`)
      );
    }
  }
  return lines;
}
