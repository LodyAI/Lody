import {
  machineSupportsIosSimulatorProtocol,
  type IosSimulatorDevice,
  type IosSimulatorResponse,
  type MachineProtocolCapabilities,
} from '@lody/shared';
import type {
  IosSimulatorDeviceEntry,
  IosSimulatorDeviceFamily,
  IosSimulatorDeviceState,
  IosSimulatorPanelStatus,
  IosSimulatorRuntimeEntry,
  IosSimulatorViewerState,
} from './ios-simulator-types';

export type IosSimulatorPanelAvailability = 'hidden' | 'upgrade-required' | 'available';

/**
 * The tab exists only for a Session whose TARGET machine is a Mac. That machine
 * may be too old to answer the simulator RPC; the tab still appears so it can
 * say so, rather than silently missing on the one machine that could run it.
 */
export function getIosSimulatorPanelAvailability(
  machine:
    | { os?: string | null; protocolCapabilities?: MachineProtocolCapabilities }
    | null
    | undefined
): IosSimulatorPanelAvailability {
  if (machine?.os !== 'darwin') return 'hidden';
  return machineSupportsIosSimulatorProtocol(machine) ? 'available' : 'upgrade-required';
}

// ---------------------------------------------------------------------------
// Catalog: the machine's `simctl` view, shaped for a picker.

const RUNTIME_IDENTIFIER = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/;
const RUNTIME_DISPLAY = /^([A-Za-z]+)\s+(\d+(?:\.\d+)*)/;
const PLATFORM_NAMES: Record<string, string> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  watchos: 'watchOS',
  tvos: 'tvOS',
  visionos: 'visionOS',
  xros: 'visionOS',
};

/** Reads either a display name (`iOS 18.2`) or an identifier (`…SimRuntime.iOS-18-2`). */
export function describeIosSimulatorRuntime(runtime: string): IosSimulatorRuntimeEntry {
  const identifier = RUNTIME_IDENTIFIER.exec(runtime);
  const display = identifier ? null : RUNTIME_DISPLAY.exec(runtime.trim());
  const match = identifier ?? display;
  if (!match) return { key: runtime, name: runtime, platform: '', version: '' };
  const [, rawPlatform, rawVersion] = match;
  if (!rawPlatform || !rawVersion)
    return { key: runtime, name: runtime, platform: '', version: '' };
  const platform = PLATFORM_NAMES[rawPlatform.toLowerCase()] ?? rawPlatform;
  const version = identifier ? rawVersion.replace(/-/g, '.') : rawVersion;
  return {
    key: runtime,
    name: identifier ? `${platform} ${version}` : runtime.trim(),
    platform,
    version,
  };
}

export function getIosSimulatorDeviceFamily(
  deviceType: string,
  name: string
): IosSimulatorDeviceFamily {
  const text = `${deviceType} ${name}`.toLowerCase();
  if (text.includes('ipad')) return 'ipad';
  if (text.includes('iphone') || text.includes('ipod')) return 'iphone';
  if (text.includes('watch')) return 'watch';
  if (text.includes('apple tv') || text.includes('appletv') || /\btv\b/.test(text)) return 'tv';
  if (text.includes('vision')) return 'vision';
  return 'other';
}

/** `simctl` spells states `Booted`, `Shutdown`, `Shutting Down`, …; case and spacing vary. */
export function normalizeIosSimulatorState(state: string): IosSimulatorDeviceState {
  switch (state.toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'booted':
      return 'booted';
    case 'booting':
      return 'booting';
    case 'shutdown':
      return 'shutdown';
    case 'shuttingdown':
      return 'shutting-down';
    default:
      return 'unknown';
  }
}

export function toIosSimulatorDeviceEntry(device: IosSimulatorDevice): IosSimulatorDeviceEntry {
  return {
    udid: device.udid,
    name: device.name,
    runtimeKey: device.runtime,
    deviceType: device.deviceType,
    family: getIosSimulatorDeviceFamily(device.deviceType, device.name),
    state: normalizeIosSimulatorState(device.state),
    available: device.available,
    unavailableReason: device.unavailableReason,
    occupancy: device.occupancy,
  };
}

export type IosSimulatorCatalog = {
  runtimes: IosSimulatorRuntimeEntry[];
  devices: IosSimulatorDeviceEntry[];
};

export function toIosSimulatorCatalog(devices: readonly IosSimulatorDevice[]): IosSimulatorCatalog {
  const runtimes = new Map<string, IosSimulatorRuntimeEntry>();
  for (const device of devices) {
    if (!runtimes.has(device.runtime)) {
      runtimes.set(device.runtime, describeIosSimulatorRuntime(device.runtime));
    }
  }
  return { runtimes: [...runtimes.values()], devices: devices.map(toIosSimulatorDeviceEntry) };
}

export type IosSimulatorDeviceGroup = {
  runtime: IosSimulatorRuntimeEntry;
  devices: IosSimulatorDeviceEntry[];
};

const PLATFORM_ORDER = ['ios', 'ipados', 'watchos', 'tvos', 'visionos'];
const FAMILY_ORDER: IosSimulatorDeviceFamily[] = [
  'iphone',
  'ipad',
  'watch',
  'tv',
  'vision',
  'other',
];

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const platformRank = (platform: string): number => {
  const index = PLATFORM_ORDER.indexOf(platform.toLowerCase());
  return index === -1 ? PLATFORM_ORDER.length : index;
};

/** Runtimes read newest-first inside each platform, platforms in Xcode's order. */
export function compareIosSimulatorRuntimes(
  a: IosSimulatorRuntimeEntry,
  b: IosSimulatorRuntimeEntry
) {
  return (
    platformRank(a.platform) - platformRank(b.platform) ||
    naturalCollator.compare(a.platform, b.platform) ||
    naturalCollator.compare(b.version, a.version) ||
    naturalCollator.compare(a.name, b.name)
  );
}

const compareDevices = (a: IosSimulatorDeviceEntry, b: IosSimulatorDeviceEntry) =>
  FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
  naturalCollator.compare(a.name, b.name) ||
  a.udid.localeCompare(b.udid);

export type IosSimulatorDeviceFilter = {
  query?: string;
  /** Restrict to one runtime key; `null` keeps every runtime. */
  runtimeKey?: string | null;
};

/** Every device, grouped under its runtime, filtered by a search and one runtime. */
export function groupIosSimulatorDevices(
  catalog: IosSimulatorCatalog,
  filter: IosSimulatorDeviceFilter = {}
): IosSimulatorDeviceGroup[] {
  const runtimeByKey = new Map(catalog.runtimes.map((runtime) => [runtime.key, runtime]));
  const tokens = (filter.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const byRuntime = new Map<string, IosSimulatorDeviceEntry[]>();
  for (const device of catalog.devices) {
    if (filter.runtimeKey && device.runtimeKey !== filter.runtimeKey) continue;
    const runtime =
      runtimeByKey.get(device.runtimeKey) ?? describeIosSimulatorRuntime(device.runtimeKey);
    if (tokens.length > 0) {
      const haystack = `${device.name} ${runtime.name}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) continue;
    }
    const list = byRuntime.get(device.runtimeKey);
    if (list) list.push(device);
    else byRuntime.set(device.runtimeKey, [device]);
  }
  return [...byRuntime.entries()]
    .map(([runtimeKey, list]) => ({
      runtime: runtimeByKey.get(runtimeKey) ?? describeIosSimulatorRuntime(runtimeKey),
      devices: list.sort(compareDevices),
    }))
    .sort((a, b) => compareIosSimulatorRuntimes(a.runtime, b.runtime));
}

// ---------------------------------------------------------------------------
// Preview status.

/** The device the Session's current preview (in any phase) is about, if any. */
export function getIosSimulatorStatusUdid(status: IosSimulatorPanelStatus): string | null {
  return status.phase === 'idle' ? null : (status.udid ?? null);
}

export function getIosSimulatorOperationId(status: IosSimulatorPanelStatus): string | null {
  return status.phase === 'idle' ? null : (status.operationId ?? null);
}

/**
 * Where the viewer handshake is addressed. The frame keeps its own origin so
 * the handshake can name it exactly, which is only safe while that origin is
 * not the app's own: a same-origin viewer would reach into the product.
 */
export function getIosSimulatorViewerOrigin(viewerUrl: string, appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(viewerUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === appOrigin) return null;
  return url.origin;
}

/** Maps one `ios-simulator/control` answer onto what the panel shows. */
export function toIosSimulatorPanelStatus(
  response: IosSimulatorResponse,
  { udid, appOrigin }: { udid?: string; appOrigin: string }
): IosSimulatorPanelStatus {
  const preview = response.preview;
  if (!response.success) {
    return {
      phase: 'failed',
      udid: preview?.udid ?? udid,
      operationId: preview?.operationId,
      error: { code: response.error ?? 'failed', message: response.message },
    };
  }
  if (!preview) return { phase: 'idle' };
  switch (preview.phase) {
    case 'preparing':
    case 'booting':
    case 'connecting':
      return {
        phase: 'preparing',
        udid: preview.udid,
        operationId: preview.operationId,
        stage: preview.phase,
      };
    case 'ready': {
      const viewerOrigin = preview.viewerUrl
        ? getIosSimulatorViewerOrigin(preview.viewerUrl, appOrigin)
        : null;
      if (!preview.viewerUrl || !viewerOrigin) {
        return {
          phase: 'failed',
          udid: preview.udid,
          operationId: preview.operationId,
          error: { code: 'failed', message: 'The machine returned no usable viewer address.' },
        };
      }
      return {
        phase: 'ready',
        udid: preview.udid,
        operationId: preview.operationId,
        viewerUrl: preview.viewerUrl,
        viewerOrigin,
        transport: preview.transport,
      };
    }
    case 'closed':
      return {
        phase: 'closed',
        udid: preview.udid,
        operationId: preview.operationId,
        transport: preview.transport,
        message: preview.message,
      };
    case 'failed':
      return {
        phase: 'failed',
        udid: preview.udid,
        operationId: preview.operationId,
        error: { code: 'failed', message: preview.message },
      };
    default:
      // A phase a newer machine added: still on its way, so keep watching it
      // under the same bounded poll.
      return {
        phase: 'preparing',
        udid: preview.udid,
        operationId: preview.operationId,
        stage: 'preparing',
      };
  }
}

export type IosSimulatorDeviceAction =
  /** This Session already previews (or is preparing) this device. */
  | { kind: 'current' }
  | { kind: 'preview' }
  | { kind: 'start-and-preview' }
  /** Another Session controls it; there is no takeover. */
  | { kind: 'occupied' }
  | { kind: 'unavailable'; reason?: string }
  /** The device is mid-shutdown; it can be started once that settles. */
  | { kind: 'settling' };

export function getIosSimulatorDeviceAction(
  device: IosSimulatorDeviceEntry,
  status: IosSimulatorPanelStatus
): IosSimulatorDeviceAction {
  if (
    getIosSimulatorStatusUdid(status) === device.udid &&
    (status.phase === 'preparing' || status.phase === 'ready')
  ) {
    return { kind: 'current' };
  }
  if (!device.available) return { kind: 'unavailable', reason: device.unavailableReason };
  if (device.occupancy === 'other-session') return { kind: 'occupied' };
  if (device.state === 'shutting-down') return { kind: 'settling' };
  if (device.state === 'booted' || device.state === 'booting') return { kind: 'preview' };
  return { kind: 'start-and-preview' };
}

export function canStartIosSimulatorPreview(action: IosSimulatorDeviceAction): boolean {
  return action.kind === 'preview' || action.kind === 'start-and-preview';
}

/**
 * Which device the panel shows. A choice made in this panel wins; otherwise
 * the Session's own preview — the device it controls — then the remembered
 * choice, then a device this Session already holds, then the first booted free
 * device, then the first free one.
 */
export function resolveIosSimulatorSelection(
  devices: readonly IosSimulatorDeviceEntry[],
  {
    chosenUdid = null,
    preferredUdid = null,
    status,
  }: {
    chosenUdid?: string | null;
    preferredUdid?: string | null;
    status: IosSimulatorPanelStatus;
  }
): string | null {
  const known = new Set(devices.map((device) => device.udid));
  if (chosenUdid && known.has(chosenUdid)) return chosenUdid;
  const statusUdid = getIosSimulatorStatusUdid(status);
  if (statusUdid && status.phase !== 'failed' && known.has(statusUdid)) return statusUdid;
  if (preferredUdid && known.has(preferredUdid)) return preferredUdid;
  const held = devices.find((device) => device.occupancy === 'this-session');
  if (held) return held.udid;
  const free = devices.filter((device) => device.available && device.occupancy === 'available');
  return (free.find((device) => device.state === 'booted') ?? free[0])?.udid ?? null;
}

/**
 * Preparing is polled every second, and only so long: a start that never
 * becomes ready is reported rather than watched forever. A ready preview is not
 * polled at all — the viewer reports its own stream.
 */
export const IOS_SIMULATOR_PREPARING_POLL_MS = 1_000;
export const IOS_SIMULATOR_PREPARING_MAX_POLLS = 180;

// ---------------------------------------------------------------------------
// Viewer handshake. The panel names the frame's exact origin; the frame answers
// with its stream state for the same operation.

export const IOS_SIMULATOR_VIEWER_INIT = 'lody:ios-simulator:init';
export const IOS_SIMULATOR_VIEWER_STATE = 'lody:ios-simulator:state';
export const IOS_SIMULATOR_VIEWER_VISIBILITY = 'lody:ios-simulator:visibility';

const VIEWER_STATES: readonly IosSimulatorViewerState[] = [
  'connecting',
  'ready',
  'disconnected',
  'error',
];

/** The state a viewer message reports for `operationId`, or null for anything else. */
export function parseIosSimulatorViewerState(
  data: unknown,
  operationId: string
): IosSimulatorViewerState | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown; operationId?: unknown; state?: unknown };
  if (message.type !== IOS_SIMULATOR_VIEWER_STATE || message.operationId !== operationId) {
    return null;
  }
  return VIEWER_STATES.includes(message.state as IosSimulatorViewerState)
    ? (message.state as IosSimulatorViewerState)
    : null;
}

/** A default screen shape per family: the contract carries no screen size. */
export function getIosSimulatorAspectRatio(family: IosSimulatorDeviceFamily | undefined): number {
  switch (family) {
    case 'ipad':
      return 3 / 4;
    case 'watch':
      return 410 / 502;
    case 'tv':
    case 'vision':
      return 16 / 9;
    default:
      return 9 / 19.5;
  }
}

// ---------------------------------------------------------------------------
// Selected-device preference: local, per workspace + machine + Session. It is a
// preference, not a cache, so a cache clear keeps it.

const SELECTED_DEVICE_KEY = 'lody:iosSimulatorSelectedDevice';

export type IosSimulatorPreferenceScope = {
  accountId?: string;
  workspaceId: string;
  machineId: string;
  sessionId: string;
};

export const getIosSimulatorSelectedDeviceStorageKey = (scope: IosSimulatorPreferenceScope) =>
  `${SELECTED_DEVICE_KEY}:${scope.accountId ?? 'local'}:${scope.workspaceId}:${scope.machineId}:${scope.sessionId}`;

export function readIosSimulatorSelectedDevice(
  scope: IosSimulatorPreferenceScope | null
): string | null {
  if (!scope || typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(getIosSimulatorSelectedDeviceStorageKey(scope));
    return value && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}

export function writeIosSimulatorSelectedDevice(
  scope: IosSimulatorPreferenceScope | null,
  udid: string
): void {
  if (!scope || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(getIosSimulatorSelectedDeviceStorageKey(scope), udid);
  } catch {
    // Storage full or disabled: the choice simply is not remembered.
  }
}

// ---------------------------------------------------------------------------
// Diagnostics. Copied text may be pasted anywhere, so it never carries a URL
// (the viewer address holds a capability and a remote tunnel is private), a
// long opaque token, a device UDID, or a home-directory user name.

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(token|secret|key|password|auth|authorization|proof|nonce|signature)(\s*[=:]\s*)[^\s,;&]+/gi;
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const HOME_PATTERN = /(\/(?:Users|home)\/)[^/\s]+/g;

export function redactIosSimulatorText(text: string): string {
  return text
    .replace(URL_PATTERN, '<url>')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2<redacted>')
    .replace(UUID_PATTERN, '<id>')
    .replace(OPAQUE_TOKEN_PATTERN, '<redacted>')
    .replace(HOME_PATTERN, '$1<user>');
}

export type IosSimulatorDiagnosticsInput = {
  now: Date;
  machine: { os?: string | null; cliVersion?: string | null; online: string; local: boolean };
  availability: IosSimulatorPanelAvailability;
  status: IosSimulatorPanelStatus;
  viewerState: IosSimulatorViewerState | null;
  device?: IosSimulatorDeviceEntry | null;
  runtime?: IosSimulatorRuntimeEntry | null;
  catalog: { phase: string; deviceCount?: number; errorCode?: string; errorMessage?: string };
};

export function buildIosSimulatorDiagnostics(input: IosSimulatorDiagnosticsInput): string {
  const { status, device, runtime } = input;
  const lines = [
    'Lody iOS Simulator diagnostics',
    `time: ${input.now.toISOString()}`,
    `machine: os=${input.machine.os ?? 'unknown'} cli=${input.machine.cliVersion ?? 'unknown'} presence=${input.machine.online} local=${input.machine.local}`,
    `protocol: ${input.availability}`,
    `catalog: ${input.catalog.phase}${input.catalog.deviceCount == null ? '' : ` devices=${input.catalog.deviceCount}`}${input.catalog.errorCode ? ` error=${input.catalog.errorCode}` : ''}`,
  ];
  if (input.catalog.errorMessage) lines.push(`catalog-error: ${input.catalog.errorMessage}`);
  if (device) {
    lines.push(
      `device: ${device.name} family=${device.family} state=${device.state} available=${device.available} occupancy=${device.occupancy}`
    );
    if (device.unavailableReason) lines.push(`device-unavailable: ${device.unavailableReason}`);
  }
  if (runtime) lines.push(`runtime: ${runtime.name}`);
  switch (status.phase) {
    case 'idle':
      lines.push('preview: idle');
      break;
    case 'preparing':
      lines.push(`preview: preparing stage=${status.stage}`);
      break;
    case 'ready':
      // The viewer URL is deliberately absent, not redacted: it is a capability.
      lines.push(
        `preview: ready transport=${status.transport} viewer=${input.viewerState ?? 'unbound'}`
      );
      break;
    case 'closed':
      lines.push(`preview: closed transport=${status.transport}`);
      if (status.message) lines.push(`preview-message: ${status.message}`);
      break;
    case 'failed':
      lines.push(`preview: failed code=${status.error.code}`);
      if (status.error.message) lines.push(`preview-error: ${status.error.message}`);
      break;
  }
  return redactIosSimulatorText(lines.join('\n'));
}
