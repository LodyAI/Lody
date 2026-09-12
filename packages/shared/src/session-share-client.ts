import { z } from 'zod';
import {
  SHARE_LIMITS,
  SharePackageManifestSchema,
  ShareResourceId,
  validateShareHistory,
  verifyShareObject,
} from './session-share-package';
import type { PreparedSharePackage } from './session-share-export';

const resolvedSchema = z
  .object({
    shareId: ShareResourceId,
    deploymentId: ShareResourceId,
    manifest: SharePackageManifestSchema,
  })
  .strict();

/** Does not use the app fetch client: workspace credentials must never join these requests. */
function shareApiOrigin(origin: string): string {
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  )
    throw new Error('Invalid share API origin');
  return url.origin;
}

export async function readShareResponseBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Share unavailable');
  }
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body.cancel();
    throw new Error('Share object exceeds size limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) throw new Error('Share object exceeds size limit');
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('Share object read failed');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function readJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Invalid share JSON');
  }
}

function shareFetch(options: {
  origin: string;
  secret: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}) {
  const origin = shareApiOrigin(options.origin);
  if (!/^[a-f0-9]{64}$/.test(options.secret)) throw new Error('Invalid share credential');
  return async (path: string, init?: RequestInit) => {
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(options.signal ? [options.signal] : []),
      ...(init?.signal ? [init.signal] : []),
    ]);
    signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${options.secret}`);
    const response = await (options.fetch ?? globalThis.fetch)(`${origin}${path}`, {
      ...init,
      signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Share unavailable');
    }
    return response;
  };
}

/** Resolve once; every subsequent read is fixed to this deployment, never current again. */
export async function openStaticShare(options: {
  origin: string;
  shareId: string;
  secret: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}) {
  const shareId = ShareResourceId.parse(options.shareId);
  const request = shareFetch(options);
  const resolved = resolvedSchema.parse(
    readJson(
      await readShareResponseBytes(
        await request(`/api/shares/${shareId}`),
        SHARE_LIMITS.manifestBytes + 1024
      )
    )
  );
  if (resolved.shareId !== shareId) throw new Error('Invalid share identity');
  const prefix = `/api/shares/${shareId}/deployments/${resolved.deploymentId}/objects/`;
  const inventory = new Map(resolved.manifest.objects.map((entry) => [entry.id, entry]));
  async function readObject(objectId: string, signal?: AbortSignal) {
    const descriptor = inventory.get(objectId);
    if (!descriptor) throw new Error('Share object unavailable');
    const bytes = await readShareResponseBytes(
      await request(`${prefix}${descriptor.id}`, { signal }),
      descriptor.sizeBytes
    );
    await verifyShareObject(bytes, descriptor);
    return bytes;
  }
  return {
    ...resolved,
    readObject,
    async readHistory(conversationId: string, signal?: AbortSignal) {
      const conversation = resolved.manifest.conversations.find(
        (entry) => entry.id === conversationId
      );
      if (!conversation) throw new Error('Share conversation unavailable');
      return validateShareHistory(readJson(await readObject(conversation.historyObjectId, signal)));
    },
    async readAttachment(attachmentId: string, signal?: AbortSignal) {
      const attachment = resolved.manifest.attachments.find((entry) => entry.id === attachmentId);
      if (!attachment) throw new Error('Share attachment unavailable');
      const object = inventory.get(attachment.objectId)!;
      return {
        ...attachment,
        mediaType: object.mediaType,
        bytes: await readObject(object.id, signal),
      };
    },
  };
}

/** Upload capability cannot publish: the authenticated app commits only after sealing. */
export async function uploadPreparedShare(options: {
  origin: string;
  deploymentId: string;
  secret: string;
  prepared: PreparedSharePackage;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}): Promise<void> {
  const deploymentId = ShareResourceId.parse(options.deploymentId);
  const request = shareFetch(options);
  const totalBytes = options.prepared.manifest.objects.reduce(
    (total, object) => total + object.sizeBytes,
    0
  );
  let uploadedBytes = 0;
  // Serial uploads bound memory and simplify cancellation/retry; inventory and
  // SHA checks allow identical retries without changing an existing object.
  for (const object of options.prepared.manifest.objects) {
    const bytes = options.prepared.objects.get(object.id);
    if (!bytes) throw new Error('Incomplete share package');
    await verifyShareObject(bytes, object);
    const response = await request(`/api/share-deployments/${deploymentId}/objects/${object.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes.slice().buffer,
    });
    await response.body?.cancel();
    uploadedBytes += object.sizeBytes;
    options.onProgress?.(uploadedBytes, totalBytes);
  }
  const response = await request(`/api/share-deployments/${deploymentId}/seal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: options.prepared.manifestBytes.slice().buffer,
  });
  await response.body?.cancel();
}

export type StaticShare = Awaited<ReturnType<typeof openStaticShare>>;
