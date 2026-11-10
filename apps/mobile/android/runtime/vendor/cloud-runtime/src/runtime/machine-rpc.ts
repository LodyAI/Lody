import { clientFor } from './session';

type Grant = () => Promise<{ token: string; gatewayBaseUrl: string }>;

export type RpcReply = {
  result?: unknown;
  error?: { code?: string; message?: string; data?: unknown };
};

export async function machineRpc(
  workspaceId: string,
  machineId: string,
  method: string,
  params: unknown,
  getGrant: Grant,
  signal: AbortSignal,
  onProgress?: (progress: Record<string, unknown>) => void,
  timeoutMs = 30000,
): Promise<RpcReply> {
  const replyTo = `${workspaceId}:rpc:res:${machineId}:${crypto.randomUUID()}`;
  const response = await clientFor(replyTo, getGrant);
  signal.throwIfAborted();
  const created = await response.create({
    contentType: 'application/json',
    ttlSeconds: Math.max(300, Math.ceil(timeoutMs / 1000) + 60),
  });
  if (!created.ok) throw new Error(created.result.code);
  signal.throwIfAborted();
  const client = await clientFor(
    `${workspaceId}:rpc:req:${machineId}`,
    getGrant,
  );
  const id = crypto.randomUUID(),
    now = Date.now();
  signal.throwIfAborted();
  const sent = await client.append({
    part: {
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        rpcVersion: '1',
        workspaceId,
        machineId,
        replyTo,
        sentAt: now,
        expiresAt: now + timeoutMs,
        method,
        params,
      }),
    },
  });
  if (!sent.ok) throw new Error(sent.result.code);
  let offset = '-1';
  while (!signal.aborted) {
    const read = await response.readOnce({ offset, live: 'long-poll', signal });
    if (!read.ok) throw new Error(read.result.code);
    offset = read.result.nextOffset;
    if (!read.result.payload) continue;
    const parsed = JSON.parse(
      new TextDecoder().decode(read.result.payload.body),
    );
    for (const reply of Array.isArray(parsed) ? parsed : [parsed])
      if (reply.id === id) {
        if (
          (reply.result?.type === 'machine/acp-binary-progress' &&
            [
              'machine/acp-capabilities-refresh',
              'machine/acp-binary-install',
              'machine/acp-binary-status',
            ].includes(method)) ||
          (method === 'machine/acp-authenticate' &&
            reply.result?.type === 'machine/acp-authentication-progress')
        ) {
          onProgress?.(reply.result);
          continue;
        }
        return reply as RpcReply;
      }
  }
  throw new Error('cancelled');
}

// Code Collab and file/preview payloads travel inside an AES-GCM envelope whose
// key is derived from the owning session id, matching the machine's
// `deriveCodeCollabV2ContentKeyBytes`.
const KEY_LABEL = 'lody-code-collab-v2-bootstrap-content-key-v1';
const KEY_ID_LABEL = 'lody-code-collab-v2-bootstrap-content-key-id-v1';
const SALT = 'lody-code-collab-v2-bootstrap-salt-v1';
const AAD_LABEL = 'lody-code-collab-v2-machine-rpc-payload-v1';
export const ENVELOPE_TYPE = 'code-collab-v2-content-envelope';

export type ContentEnvelope = {
  type: typeof ENVELOPE_TYPE;
  keyVersion: 1;
  algorithm: 'AES-256-GCM';
  ownerSessionId: string;
  keyId: string;
  iv: string;
  ciphertext: string;
};

const sha256 = async (value: string) =>
  new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const toBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
const fromBase64Url = (value: string) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(
    base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='),
  );
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

export const contentKeyId = async (ownerSessionId: string) =>
  `ccv2:${hex(await sha256(`${KEY_ID_LABEL}\0${SALT}\0${ownerSessionId}`)).slice(0, 24)}`;

async function contentKey(ownerSessionId: string) {
  return crypto.subtle.importKey(
    'raw',
    await sha256(`${KEY_LABEL}\0${SALT}\0${ownerSessionId}`),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}
const aad = (ownerSessionId: string, keyId: string, keyVersion: number) =>
  new TextEncoder().encode(
    `${AAD_LABEL}\0${ownerSessionId}\0${keyId}\0${keyVersion}`,
  );

export async function sealPayload(
  ownerSessionId: string,
  payload: unknown,
): Promise<ContentEnvelope> {
  const keyId = await contentKeyId(ownerSessionId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(ownerSessionId, keyId, 1) },
      await contentKey(ownerSessionId),
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  return {
    type: ENVELOPE_TYPE,
    keyVersion: 1,
    algorithm: 'AES-256-GCM',
    ownerSessionId,
    keyId,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
  };
}

export const isEnvelope = (value: unknown): value is ContentEnvelope =>
  !!value &&
  typeof value === 'object' &&
  (value as ContentEnvelope).type === ENVELOPE_TYPE;

export async function openPayload(envelope: ContentEnvelope): Promise<unknown> {
  const { ownerSessionId, keyId, keyVersion } = envelope;
  if (keyId !== (await contentKeyId(ownerSessionId)))
    throw new Error('envelope_key_mismatch');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(envelope.iv),
      additionalData: aad(ownerSessionId, keyId, keyVersion),
    },
    await contentKey(ownerSessionId),
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function sealedRpc(
  workspaceId: string,
  machineId: string,
  method: string,
  ownerSessionId: string,
  params: unknown,
  getGrant: Grant,
  signal: AbortSignal,
): Promise<unknown> {
  const reply = await machineRpc(
    workspaceId,
    machineId,
    method,
    await sealPayload(ownerSessionId, params),
    getGrant,
    signal,
  );
  if (reply.error) {
    const data = isEnvelope(reply.error.data)
      ? await openPayload(reply.error.data)
      : reply.error.data;
    const error = new Error(
      reply.error.message ?? reply.error.code ?? 'rpc_failed',
    );
    Object.assign(error, { code: reply.error.code, data });
    throw error;
  }
  if (!isEnvelope(reply.result)) throw new Error('invalid_rpc_response');
  return openPayload(reply.result);
}
