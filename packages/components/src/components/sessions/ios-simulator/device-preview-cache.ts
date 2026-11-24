import type { IosSimulatorExterior } from '@lody/shared';

import { LRUCache } from '@/lib/lru-cache';
import type { IosSimulatorQuarterTurns } from '@/lib/ios-simulator/ios-simulator-hardware';
import type {
  IosSimulatorPanelStatus,
  IosSimulatorViewerDiagnostics,
  IosSimulatorViewerState,
} from '@/lib/ios-simulator/ios-simulator-types';
import type { IosSimulatorViewMode } from './ios-simulator-controls';
import type { IosSimulatorCatalogState } from './ios-simulator-panel-view';

export type DevicePreviewExterior = {
  geometry: IosSimulatorExterior;
  imageUrl: string;
};

export type DevicePreviewSessionSnapshot = {
  catalog: IosSimulatorCatalogState;
  status: IosSimulatorPanelStatus;
  viewerState: IosSimulatorViewerState | null;
  viewerDiagnostics: IosSimulatorViewerDiagnostics | null;
  chosenUdid: string | null;
  turns: IosSimulatorQuarterTurns;
  viewMode: IosSimulatorViewMode;
};

export type DevicePreviewFrameEntry = {
  iframe: HTMLIFrameElement;
  viewerUrl: string;
  viewerOrigin: string;
  operationId: string;
  loaded: boolean;
  parentPort: MessagePort | null;
  sentVisible: boolean | null;
  screenAspect: number | null;
  exterior?: DevicePreviewExterior;
};

type StatePreservingParent = HTMLElement & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

const MAX_CACHED_DEVICE_SNAPSHOTS = 20;
const MAX_CACHED_DEVICE_FRAMES = 4;

export const devicePreviewCacheKey = ({
  platform,
  userId,
  workspaceId,
  sessionId,
  machineId,
}: {
  platform: 'ios' | 'android';
  userId?: string | null;
  workspaceId?: string | null;
  sessionId: string;
  machineId: string;
}): string => `${platform}:${userId ?? ''}:${workspaceId ?? ''}:${sessionId}:${machineId}`;

/**
 * Only an atomic `moveBefore` preserves an iframe's browsing context, live
 * WebSocket/WebRTC stream and transferred `MessagePort` across reparenting.
 * Never fake frame caching with `appendChild`, which reloads the document.
 */
export const supportsDevicePreviewFrameCache = (): boolean =>
  typeof HTMLElement !== 'undefined' &&
  typeof (HTMLElement.prototype as StatePreservingParent).moveBefore === 'function';

const destroyFrameEntry = (entry: DevicePreviewFrameEntry): void => {
  entry.parentPort?.close();
  entry.parentPort = null;
  if (entry.exterior) {
    URL.revokeObjectURL(entry.exterior.imageUrl);
    entry.exterior = undefined;
  }
  entry.iframe.remove();
};

const snapshots = new LRUCache<string, DevicePreviewSessionSnapshot>(MAX_CACHED_DEVICE_SNAPSHOTS);
const frames = new LRUCache<string, DevicePreviewFrameEntry>(MAX_CACHED_DEVICE_FRAMES, {
  onEvict: (_key, entry) => destroyFrameEntry(entry),
});

let parkingLot: HTMLDivElement | null = null;

const getDevicePreviewParkingLot = (): HTMLDivElement => {
  if (parkingLot?.isConnected) return parkingLot;
  parkingLot = document.createElement('div');
  // Keep non-zero off-screen dimensions rather than `hidden` (`display: none`)
  // so the parked viewer does not emit a 0x0 resize / 1x1 stream-config.
  Object.assign(parkingLot.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '390px',
    height: '844px',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  parkingLot.inert = true;
  parkingLot.setAttribute('aria-hidden', 'true');
  parkingLot.setAttribute('data-lody-device-preview-parking', 'true');
  document.body.appendChild(parkingLot);
  return parkingLot;
};

const moveFrame = (parent: HTMLElement, entry: DevicePreviewFrameEntry): boolean => {
  const statePreservingParent = parent as StatePreservingParent;
  if (
    entry.iframe.isConnected &&
    parent.isConnected &&
    typeof statePreservingParent.moveBefore === 'function'
  ) {
    try {
      statePreservingParent.moveBefore(entry.iframe, null);
      return true;
    } catch {
      // Fall through if the engine rejects the atomic move.
    }
  }
  parent.appendChild(entry.iframe);
  entry.loaded = false;
  entry.parentPort?.close();
  entry.parentPort = null;
  return false;
};

const createFrameEntry = ({
  viewerUrl,
  viewerOrigin,
  operationId,
  title,
  frameClassName,
}: {
  viewerUrl: string;
  viewerOrigin: string;
  operationId: string;
  title: string;
  frameClassName?: string;
}): DevicePreviewFrameEntry => {
  const iframe = document.createElement('iframe');
  if (frameClassName) iframe.className = frameClassName;
  iframe.title = title;
  iframe.draggable = false;
  iframe.referrerPolicy = 'no-referrer';
  // Same explicit sandbox contract as IosSimulatorViewer.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.src = viewerUrl;
  return {
    iframe,
    viewerUrl,
    viewerOrigin,
    operationId,
    loaded: false,
    parentPort: null,
    sentVisible: null,
    screenAspect: null,
  };
};

export const readDevicePreviewSnapshot = (key: string): DevicePreviewSessionSnapshot | null =>
  snapshots.get(key) ?? null;

export const rememberDevicePreviewSnapshot = (
  key: string,
  snapshot: DevicePreviewSessionSnapshot
): void => {
  snapshots.set(key, snapshot);
};

export const acquireDevicePreviewFrame = ({
  cacheKey,
  viewerUrl,
  viewerOrigin,
  operationId,
  title,
  frameClassName,
  host,
}: {
  cacheKey: string;
  viewerUrl: string;
  viewerOrigin: string;
  operationId: string;
  title: string;
  frameClassName?: string;
  host: HTMLElement;
}): { entry: DevicePreviewFrameEntry; reused: boolean } => {
  const existing = frames.get(cacheKey);
  if (
    existing &&
    existing.viewerUrl === viewerUrl &&
    existing.viewerOrigin === viewerOrigin &&
    existing.operationId === operationId
  ) {
    existing.iframe.title = title;
    if (frameClassName) existing.iframe.className = frameClassName;
    frames.set(cacheKey, existing);
    const preserved = moveFrame(host, existing);
    return { entry: existing, reused: preserved && existing.loaded };
  }

  if (existing) {
    frames.delete(cacheKey);
    destroyFrameEntry(existing);
  }

  const entry = createFrameEntry({
    viewerUrl,
    viewerOrigin,
    operationId,
    title,
    frameClassName,
  });
  frames.set(cacheKey, entry);
  host.appendChild(entry.iframe);
  return { entry, reused: false };
};

export const releaseDevicePreviewFrame = (cacheKey: string, iframe: HTMLIFrameElement): boolean => {
  const entry = frames.get(cacheKey);
  if (!entry || entry.iframe !== iframe) {
    iframe.remove();
    return false;
  }
  if (!supportsDevicePreviewFrameCache()) {
    frames.delete(cacheKey);
    destroyFrameEntry(entry);
    return false;
  }
  if (entry.parentPort) {
    entry.parentPort.onmessage = null;
  }
  const preserved = moveFrame(getDevicePreviewParkingLot(), entry);
  if (!preserved) {
    frames.delete(cacheKey);
    destroyFrameEntry(entry);
    return false;
  }
  return true;
};

export const clearDevicePreviewFrame = (cacheKey: string): void => {
  const entry = frames.get(cacheKey);
  if (!entry) return;
  frames.delete(cacheKey);
  destroyFrameEntry(entry);
};

export const clearDevicePreviewCache = (cacheKey: string): void => {
  clearDevicePreviewFrame(cacheKey);
  snapshots.delete(cacheKey);
};

export const clearAllDevicePreviewCaches = (): void => {
  for (const entry of frames.values()) {
    destroyFrameEntry(entry);
  }
  frames.clear();
  snapshots.clear();
};
