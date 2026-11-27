import { z } from 'zod';
import {
  ElectronLoginStateSchema,
  type ElectronPublicBrowserBounds,
  type ElectronPublicBrowserState,
  type ElectronPublicBrowserInteraction,
  type IpcPushMap,
  type IpcSendMap,
  type SendLocalSessionControlResult,
} from '@lody/shared/electron-ipc';
import {
  decodeExternalObject,
  formatBoundaryDecodeDiagnostic,
} from '@lody/shared/boundary-decode';
import type { LocalSessionControlRequest, LocalSessionControlResponse } from '@lody/shared';
import { LocalSessionControlResponseSchema } from '@lody/shared/message-schemas';
import { recordClientLog } from './client-log';
// This deliberately crosses from the shared renderer package into the Electron app at
// type level only. The import is erased from every browser bundle; see both packages'
// AGENTS.md files before changing it into a runtime dependency or duplicating the API.
import type { ElectronIpcServices } from '../../../../apps/electron/src/main/ipc/register-services';

export type IpcServices = ElectronIpcServices;

export type LodyIpcInvokeBridge = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

export function createLodyIpcProxy<T extends Record<string, object> = IpcServices>(
  ipc: LodyIpcInvokeBridge | null | undefined
): T | null {
  if (!ipc) return null;
  const cache = new Map<string, object>();
  return new Proxy({} as T, {
    get(_target, groupName: string) {
      let group = cache.get(groupName);
      if (!group) {
        group = new Proxy(
          {},
          {
            get(_g, methodName: string) {
              return (...args: unknown[]) => ipc.invoke(`${groupName}.${methodName}`, ...args);
            },
          }
        );
        cache.set(groupName, group);
      }
      return group;
    },
  });
}

function readIpcBridge(): LodyIpcInvokeBridge | null {
  if (typeof window === 'undefined') return null;
  return window.ipc ?? null;
}

export function getIpcServices(): IpcServices | null {
  return createLodyIpcProxy<IpcServices>(readIpcBridge());
}

const ElectronWindowTargetSchema = z
  .object({
    workspace: z.string().min(1),
    sessionId: z.string().min(1).optional(),
  })
  .passthrough();

const PreparedWindowTargetSchema = ElectronWindowTargetSchema.extend({
  preparationId: z.string().min(1),
});

const IPC_PUSH_SCHEMAS: Partial<{ [K in keyof IpcPushMap]: z.ZodType<IpcPushMap[K]> }> = {
  'auth.loginState': ElectronLoginStateSchema,
  'app.deepLink': z.string(),
  'app.menuAction': z.string(),
  'app.fullscreen': z.boolean(),
  'loro.status': z.boolean(),
  'app.nativeTheme': z.enum(['light', 'dark']),
  'app.windowTarget': ElectronWindowTargetSchema,
  'app.prepareWindowTarget': PreparedWindowTargetSchema,
  'app.activatePreparedWindow': PreparedWindowTargetSchema,
  'e2ee.accessLost': z.object({ workspaceId: z.string().min(1) }).passthrough(),
};

function decodeIpcPushPayload<K extends keyof IpcPushMap>(
  channel: K,
  payload: unknown
): { ok: true; data: IpcPushMap[K] } | { ok: false } {
  const schema = IPC_PUSH_SCHEMAS[channel] as z.ZodType<IpcPushMap[K]> | undefined;
  if (!schema) {
    return { ok: true, data: payload as IpcPushMap[K] };
  }
  const decoded = decodeExternalObject(`electron.ipc.push.${channel}`, schema, payload, {
    onDiagnostic: (diagnostic) => {
      const summary = formatBoundaryDecodeDiagnostic(diagnostic);
      console.warn(`[IPC] ${summary}`);
      recordClientLog('warn', 'boundary.decode', summary, {
        boundary: diagnostic.boundary,
        kind: diagnostic.kind,
        issueCount: diagnostic.issueCount,
      });
    },
  });
  return decoded.ok ? { ok: true, data: decoded.data } : { ok: false };
}

export function onIpcEvent<K extends keyof IpcPushMap>(
  channel: K,
  handler: (payload: IpcPushMap[K]) => void
): () => void {
  if (typeof window === 'undefined' || !window.ipc) return () => {};
  return window.ipc.on(channel, (payload) => {
    const decoded = decodeIpcPushPayload(channel, payload);
    if (decoded.ok) {
      handler(decoded.data);
    }
  });
}

export function sendIpc<K extends keyof IpcSendMap>(channel: K, payload: IpcSendMap[K]): void {
  window.ipc?.send(channel, payload);
}

export async function sendLocalSessionControl(
  message: LocalSessionControlRequest,
  onResponse?: (response: LocalSessionControlResponse) => void
): Promise<SendLocalSessionControlResult> {
  const services = getIpcServices();
  if (!services) return { ok: false, error: 'ipc_unavailable' };
  const requestId = crypto.randomUUID();
  const stop = onIpcEvent('sessionControl.response', (event) => {
    if (event.requestId !== requestId) return;
    const parsed = LocalSessionControlResponseSchema.safeParse(event.response, { jitless: true });
    if (parsed.success) onResponse?.(parsed.data as LocalSessionControlResponse);
  });
  try {
    return await services.sessionControl.send({ requestId, message });
  } finally {
    stop();
  }
}

export function getPublicBrowserBridge() {
  const services = getIpcServices();
  if (!services) return null;
  const pub = services.publicBrowser;
  return {
    capability: 'web-contents-view-v1' as const,
    create: (browserId: string, bounds: ElectronPublicBrowserBounds) =>
      pub.create({ browserId, bounds }),
    navigate: (browserId: string, url: string) => pub.navigate({ browserId, url }),
    back: (browserId: string) => pub.back({ browserId }),
    forward: (browserId: string) => pub.forward({ browserId }),
    reload: (browserId: string) => pub.reload({ browserId }),
    stop: (browserId: string) => pub.stop({ browserId }),
    setBounds: (browserId: string, bounds: ElectronPublicBrowserBounds) =>
      pub.setBounds({ browserId, bounds }),
    setVisible: (browserId: string, visible: boolean, trackInteraction?: boolean) =>
      pub.setVisible({
        browserId,
        visible,
        ...(trackInteraction === undefined ? {} : { trackInteraction }),
      }),
    destroy: (browserId: string) => pub.destroy({ browserId }),
    onState: (handler: (state: ElectronPublicBrowserState) => void) =>
      onIpcEvent('publicBrowser.state', handler),
    onInteraction: (handler: (event: ElectronPublicBrowserInteraction) => void) =>
      onIpcEvent('publicBrowser.interaction', handler),
  };
}
