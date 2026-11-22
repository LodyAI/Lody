import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PersonalIrohEndpoint } from '@lody/e2ee-client';

/** Narrow `LodyIroh` plugin: open/status/send/receive only. Native never returns the seed. */
export interface NativeIrohBridge {
  open(input: {
    seed: string;
    relays: string[];
    relayToken?: string;
    proxyUrl?: string;
  }): Promise<unknown>;
  connectionPath?(input: { handle: string; endpointId: string }): Promise<unknown>;
  hasConnection(input: { handle: string; endpointId: string }): Promise<unknown>;
  warm(input: { handle: string; endpointId: string; timeoutMs: number }): Promise<unknown>;
  call(input: {
    handle: string;
    endpointId: string;
    request: string;
    connectTimeoutMs: number;
  }): Promise<unknown>;
  nextReply(input: { call: string }): Promise<unknown>;
  cancel(input: { call: string }): Promise<unknown>;
  close(input: { handle: string }): Promise<unknown>;
}

export type IrohRelays = {
  readonly urls: readonly string[];
  readonly token?: string;
  /** Test builds only (`VITE_IROH_PROXY_URL`): an HTTP proxy for relay traffic. */
  readonly proxyUrl?: string;
};

const MAX_FRAME = 2 * 1024 * 1024 + 4096;
const HANDLE = /^[A-Za-z0-9-]{1,64}$/;

const encode = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const decode = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_FRAME / 3) * 4)
    throw new Error('iroh_reply_invalid');
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
};
const field = (value: unknown, name: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;
const handleOf = (value: unknown, name: string): string => {
  const handle = field(value, name);
  if (typeof handle !== 'string' || !HANDLE.test(handle)) throw new Error('iroh_reply_invalid');
  return handle;
};

/** Relays come only from the official build; absence keeps encrypted Streams RPC. */
export function irohRelaysFromBuild(
  env: Readonly<Record<string, unknown>>
): IrohRelays | undefined {
  const urls = (typeof env.VITE_IROH_RELAYS === 'string' ? env.VITE_IROH_RELAYS : '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0 || urls.length > 16) return undefined;
  for (const url of urls) {
    try {
      if (new URL(url).protocol !== 'https:') return undefined;
    } catch {
      return undefined;
    }
  }
  const token =
    typeof env.VITE_IROH_RELAY_TOKEN === 'string' ? env.VITE_IROH_RELAY_TOKEN.trim() : '';
  const proxy = typeof env.VITE_IROH_PROXY_URL === 'string' ? env.VITE_IROH_PROXY_URL.trim() : '';
  if (proxy) {
    try {
      if (!['http:', 'https:'].includes(new URL(proxy).protocol)) return undefined;
    } catch {
      return undefined;
    }
  }
  return { urls, ...(token ? { token } : {}), ...(proxy ? { proxyUrl: proxy } : {}) };
}

/**
 * The portable host's iroh port. The seed crosses the bridge once per session as
 * base64; that JS string cannot be wiped (accepted by the foundations Spec).
 */
export function irohPort(bridge: NativeIrohBridge, relays: IrohRelays) {
  return {
    open: async (seed: Uint8Array): Promise<PersonalIrohEndpoint> => {
      const handle = handleOf(
        await bridge.open({
          seed: encode(seed),
          relays: [...relays.urls],
          ...(relays.token ? { relayToken: relays.token } : {}),
          ...(relays.proxyUrl ? { proxyUrl: relays.proxyUrl } : {}),
        }),
        'handle'
      );
      return {
        connectionPath: async (endpointId) => {
          const value = field(await bridge.connectionPath?.({ handle, endpointId }), 'value');
          return value === 'direct' || value === 'relay' ? value : 'none';
        },
        hasConnection: async (endpointId) =>
          field(await bridge.hasConnection({ handle, endpointId }), 'value') === true,
        warm: async (endpointId, timeoutMs) => {
          await bridge.warm({ handle, endpointId, timeoutMs });
        },
        call: async (endpointId, request, connectTimeoutMs) => {
          if (request.length > MAX_FRAME) throw new Error('iroh_request_too_large');
          const call = handleOf(
            await bridge.call({ handle, endpointId, request: encode(request), connectTimeoutMs }),
            'call'
          );
          return {
            nextReply: async () => {
              const reply = field(await bridge.nextReply({ call }), 'reply');
              return reply === null || reply === undefined ? null : decode(reply);
            },
            cancel: () => {
              void bridge.cancel({ call }).catch(() => undefined);
            },
          };
        },
        close: async () => {
          await bridge.close({ handle });
        },
      };
    },
  };
}

/** Registers the proxy only on a native shell that ships the plugin and a relay set. */
export function nativeIrohPort(
  env: Readonly<Record<string, unknown>> = import.meta.env
): ReturnType<typeof irohPort> | undefined {
  const relays = irohRelaysFromBuild(env);
  if (!relays || !Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LodyIroh'))
    return undefined;
  return irohPort(registerPlugin<NativeIrohBridge>('LodyIroh'), relays);
}
