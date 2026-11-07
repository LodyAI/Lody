import type { LoroDoc } from 'loro-crdt/base64';
import type { RpcReply } from './machine-rpc';

export type PreviewTarget = {
  protocol: 'http' | 'https';
  host: string;
  port: number;
  path?: string;
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TOKEN_PARAM = '__lody_preview_token';

function target(value: unknown): PreviewTarget | undefined {
  const item = value as Record<string, unknown> | undefined;
  if (
    !item ||
    (item.protocol !== 'http' && item.protocol !== 'https') ||
    typeof item.host !== 'string' ||
    !LOOPBACK.has(item.host.trim().toLowerCase()) ||
    typeof item.port !== 'number' ||
    !Number.isInteger(item.port) ||
    item.port < 1 ||
    item.port > 65535
  )
    return undefined;
  if (item.path === undefined)
    return { protocol: item.protocol, host: item.host, port: item.port };
  if (typeof item.path !== 'string' || !item.path.startsWith('/'))
    return undefined;
  return {
    protocol: item.protocol,
    host: item.host,
    port: item.port,
    path: item.path,
  };
}

export function previewSummary(
  doc: LoroDoc,
): { label: string; active: boolean } | undefined {
  const target = previewTarget(doc);
  if (!target) return undefined;
  const status = (doc.getMap('preview').toJSON() as Record<string, any>)
    .connection?.status;
  return {
    label: `${target.host}:${target.port}`,
    active: status === 'active' || status === 'creating',
  };
}

export function previewTarget(doc: LoroDoc): PreviewTarget | undefined {
  const state = doc.getMap('preview').toJSON() as Record<string, any>;
  if (['reported', 'validating', 'available'].includes(state.candidate?.status))
    return target(state.candidate.target);
  if (['creating', 'active'].includes(state.connection?.status))
    return target(state.connection.target);
  return undefined;
}

export function viewerUrl(publicUrl: unknown, path = '/'): string | undefined {
  if (typeof publicUrl !== 'string') return undefined;
  let gateway: URL;
  try {
    gateway = new URL(publicUrl);
  } catch {
    return undefined;
  }
  if (
    gateway.protocol !== 'https:' ||
    gateway.username ||
    gateway.password ||
    gateway.port ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(gateway.hostname) ||
    !gateway.searchParams.get(TOKEN_PARAM)
  )
    return undefined;
  const viewer = new URL(path, gateway.origin);
  // A `//host` path would otherwise resolve to a different origin.
  if (viewer.origin !== gateway.origin) return undefined;
  gateway.searchParams.forEach((value, name) =>
    viewer.searchParams.set(name, value),
  );
  return viewer.href;
}

type ControlArgs = {
  workspaceId: string;
  machineId: string;
  sessionId: string;
  userId: string;
  rpc: (method: string, params: object, timeoutMs: number) => Promise<RpcReply>;
  mintToken: (intent: object) => Promise<unknown>;
};
type ControlResult = { url?: string; error?: string; message?: string };

async function proof(args: ControlArgs, operation: object) {
  // Older CLIs drop unknown methods without replying, so silence means unsupported.
  const control = await args
    .rpc('machine/preview-control', {}, 15_000)
    .catch(() => undefined);
  const nonce = (control?.result as Record<string, unknown> | undefined)
    ?.runtimeNonce;
  if (typeof nonce !== 'string') return { error: 'unsupported' };
  const requestId = crypto.randomUUID();
  const requestToken = await args.mintToken({
    workspaceId: args.workspaceId,
    machineId: args.machineId,
    sessionId: args.sessionId,
    runtimeNonce: nonce,
    requestId,
    operation,
  });
  if (typeof requestToken === 'string')
    return { proof: { runtimeNonce: nonce, requestId, requestToken } };
  const status = (requestToken as { status?: number } | undefined)?.status;
  if (!status) return { error: 'unauthorized' };
  return {
    error: status === 400 ? 'backend_rejected' : 'unauthorized',
    status,
  };
}

const RPC_SECRET_AAD_LABEL = 'lody-machine-rpc-secret-v1';
const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromBase64Url = (value: string) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
    (char) => char.charCodeAt(0),
  );
};

async function responseRecipient() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  );
  const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const key = {
    type: 'rpc-secret-public-key-v1',
    algorithm: 'ECDH-P256-AES-256-GCM',
    keyId: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    publicKey: { kty: 'EC', crv: 'P-256', x, y },
  };
  const decrypt = async (envelope: Record<string, any>, context: string) => {
    if (envelope.keyId !== key.keyId) throw new Error('key_mismatch');
    const sender = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: envelope.ephemeralPublicKey?.x,
        y: envelope.ephemeralPublicKey?.y,
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: sender },
      pair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv),
        additionalData: new TextEncoder().encode(
          `${RPC_SECRET_AAD_LABEL}\0${key.keyId}\0${context}`,
        ),
      },
      shared,
      fromBase64Url(envelope.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  };
  return { key, decrypt };
}

function simulatorViewerUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(url.hostname)
  )
    throw new Error('invalid_viewer_url');
  return url.href;
}

export async function iosSimulatorControl(
  args: ControlArgs & { command: { action: string } },
) {
  const recipient = await responseRecipient();
  const signed = await proof(args, {
    action: 'ios-simulator',
    command: args.command,
    responseKey: recipient.key,
  });
  if (!signed.proof) return signed;
  const reply = await args.rpc(
    'ios-simulator/control',
    {
      sessionId: args.sessionId,
      requestedByUserId: args.userId,
      command: args.command,
      proof: signed.proof,
      responseKey: recipient.key,
    },
    45_000,
  );
  const result = reply.result as Record<string, any> | undefined;
  if (result?.success !== true) return failure(reply);
  if (!result.preview) return result;
  const { viewerUrlEnvelope, ...preview } = result.preview;
  if (!viewerUrlEnvelope) return { ...result, preview };
  const context = JSON.stringify([
    'ios-simulator/control',
    args.workspaceId,
    args.machineId,
    args.sessionId,
    signed.proof.requestId,
  ]);
  const viewerUrl = simulatorViewerUrl(
    await recipient.decrypt(viewerUrlEnvelope, context),
  );
  return { ...result, preview: { ...preview, viewerUrl } };
}

function failure(reply: RpcReply): ControlResult {
  const result = reply.result as Record<string, any> | undefined;
  return {
    error: result?.error ?? reply.error?.code ?? 'failed',
    message: result?.message ?? reply.error?.message,
  };
}

export async function createPreview(
  args: ControlArgs & { target: PreviewTarget },
): Promise<ControlResult> {
  const signed = await proof(args, {
    action: 'create',
    target: args.target,
    restart: false,
  });
  if (!signed.proof) return signed;
  const reply = await args.rpc(
    'session/preview-create',
    {
      sessionId: args.sessionId,
      requestedByUserId: args.userId,
      proof: signed.proof,
      target: args.target,
      approval: {
        source: 'browser_address',
        targetClass: 'loopback',
        target: args.target,
        confirmedByUserId: args.userId,
        confirmedAt: Date.now(),
      },
    },
    290_000,
  );
  const result = reply.result as Record<string, any> | undefined;
  const url = viewerUrl(result?.connection?.publicUrl, args.target.path);
  if (result?.success === true && url) return { url };
  return failure(reply);
}

export async function revokePreview(args: ControlArgs): Promise<ControlResult> {
  const signed = await proof(args, { action: 'revoke' });
  if (!signed.proof) return signed;
  const reply = await args.rpc(
    'session/preview-revoke',
    {
      sessionId: args.sessionId,
      requestedByUserId: args.userId,
      proof: signed.proof,
    },
    35_000,
  );
  if ((reply.result as Record<string, unknown> | undefined)?.success === true)
    return {};
  return failure(reply);
}
