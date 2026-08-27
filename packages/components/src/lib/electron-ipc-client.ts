import type {
  ElectronPublicBrowserBounds,
  ElectronPublicBrowserState,
  IpcPushMap,
  IpcSendMap,
  SendLocalSessionControlResult,
} from '@lody/shared/electron-ipc';
import type { LocalSessionControlRequest, LocalSessionControlResponse } from '@lody/shared';
import { LocalSessionControlResponseSchema } from '@lody/shared/message-schemas';
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

export function onIpcEvent<K extends keyof IpcPushMap>(
  channel: K,
  handler: (payload: IpcPushMap[K]) => void
): () => void {
  if (typeof window === 'undefined' || !window.ipc) return () => {};
  return window.ipc.on(channel, (payload) => handler(payload as IpcPushMap[K]));
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
    setVisible: (browserId: string, visible: boolean) => pub.setVisible({ browserId, visible }),
    destroy: (browserId: string) => pub.destroy({ browserId }),
    onState: (handler: (state: ElectronPublicBrowserState) => void) =>
      onIpcEvent('publicBrowser.state', handler),
  };
}
