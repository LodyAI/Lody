import {
  SHARE_LIMITS,
  SESSION_SHARE_FILE_ATTACHMENTS_ENABLED,
  SharePackageManifestSchema,
  ShareResourceId,
  encodeShareJson,
  captureShareHistory,
  shareObjectDigest,
  validateShareHistory,
  type ShareAttachment,
  type ShareConversation,
  type ShareJson,
  type ShareObject,
  type SharePackageManifest,
} from './session-share-package';
import { mapShareConcurrent } from './session-share-concurrency';

export type ShareSourceConversation = {
  sourceId: string;
  title: string;
  history: unknown;
  parentSourceId?: string;
  openedBySourceId?: string;
  childSessionPlacement?: 'side-panel';
};

export type PreparedSharePackage = {
  manifest: SharePackageManifest;
  manifestBytes: Uint8Array;
  manifestHash: string;
  objects: ReadonlyMap<string, Uint8Array>;
  /** Private management hints; never include this mapping in uploaded JSON. */
  sourceIds: { sourceId: string; conversationId: string }[];
};

export type ShareAttachmentSource = {
  conversationSourceId: string;
  kind: 'image' | 'file';
  reference: Readonly<Record<string, ShareJson>>;
};

/**
 * Capture is synchronous, before the first I/O. The host must supply hydrated,
 * readable/decrypted history; server code never owns this adapter. Attachment
 * loading only receives explicit typed references, never arbitrary raw tool URLs.
 */
export async function prepareSharePackage(options: {
  rootSourceId: string;
  conversations: readonly ShareSourceConversation[];
  previousSourceIds?: readonly { sourceId: string; conversationId: string }[];
  capturedAt: string;
  /** Capture policy only; the server independently authorizes the inventory. */
  fileAttachmentsEnabled?: boolean;
  fileAttachmentOmissionText?: string;
  readAttachment: (
    source: ShareAttachmentSource,
    signal?: AbortSignal
  ) => Promise<{
    bytes: Uint8Array;
    mediaType: string;
  }>;
  signal?: AbortSignal;
  /** App supplies worker-backed Zstd; service and reader bundles never load the encoder. */
  compressHistory?: (bytes: Uint8Array) => Promise<Uint8Array>;
}): Promise<PreparedSharePackage> {
  if (!options.conversations.length || options.conversations.length > SHARE_LIMITS.conversations) {
    throw new Error('Invalid share selection');
  }
  const ids = new Map<string, string>();
  const reserved = new Set<string>();
  for (const entry of options.previousSourceIds ?? []) {
    if (ids.has(entry.sourceId) || reserved.has(entry.conversationId))
      throw new Error('Invalid share identity');
    ShareResourceId.parse(entry.conversationId);
    ids.set(entry.sourceId, entry.conversationId);
    reserved.add(entry.conversationId);
  }
  let nextId = 1;
  let capturedBytes = 0;
  const selected = new Set<string>();
  // Serialize/decode once to detach from every live Mirror container and pointer.
  const captured = options.conversations.map((source) => {
    if (selected.has(source.sourceId)) throw new Error('Duplicate share selection');
    selected.add(source.sourceId);
    let id = ids.get(source.sourceId);
    if (!id) {
      while (reserved.has(`c${nextId}`)) nextId++;
      id = `c${nextId++}`;
      ids.set(source.sourceId, id);
      reserved.add(id);
    }
    const bytes = encodeShareJson(captureShareHistory(source.history), SHARE_LIMITS.historyBytes);
    capturedBytes += bytes.length;
    if (capturedBytes > SHARE_LIMITS.deploymentBytes)
      throw new Error('Share package exceeds size limit');
    // Keep compact wire titles omitted until the reader materializes the history.
    const history = validateShareHistory(JSON.parse(new TextDecoder().decode(bytes)), {
      restoreTitles: false,
    });
    return { ...source, id, history };
  });
  if (!selected.has(options.rootSourceId)) throw new Error('Share root not selected');
  const objects = new Map<string, Uint8Array>();
  const inventory: ShareObject[] = [];
  const attachments: ShareAttachment[] = [];
  const conversations: ShareConversation[] = [];
  // Repeated typed references share a copied object only within this deployment.
  const copied = new Map<
    string,
    { id: string; source: ShareAttachmentSource; references: Record<string, ShareJson>[] }
  >();
  let totalBytes = 0;
  async function addObject(
    id: string,
    bytes: Uint8Array,
    mediaType: string,
    encoding?: Pick<ShareObject, 'contentEncoding' | 'decodedSizeBytes'>
  ) {
    options.signal?.throwIfAborted();
    if (bytes.length > SHARE_LIMITS.objectBytes) throw new Error('Share object exceeds size limit');
    totalBytes += bytes.length;
    if (totalBytes > SHARE_LIMITS.deploymentBytes)
      throw new Error('Share package exceeds size limit');
    // Own the bytes: a host cache cannot mutate the confirmed artifact later.
    const owned = bytes.slice();
    const descriptor: ShareObject = {
      id,
      mediaType,
      sizeBytes: owned.length,
      sha256: await shareObjectDigest(owned),
      ...encoding,
    };
    inventory.push(descriptor);
    objects.set(id, owned);
    return descriptor;
  }

  function copyAttachment(
    reference: Record<string, ShareJson>,
    kind: 'image' | 'file',
    sourceId: string
  ) {
    const sourceObjectId = reference[kind === 'image' ? 'imageId' : 'fileId'];
    if (typeof sourceObjectId !== 'string') throw new Error('Invalid share attachment');
    const key = JSON.stringify([
      kind,
      reference.storageSessionId ?? sourceId,
      reference.machineId ?? null,
      sourceObjectId,
    ]);
    let copy = copied.get(key);
    if (!copy) {
      if (copied.size >= SHARE_LIMITS.attachments) throw new Error('Too many share attachments');
      options.signal?.throwIfAborted();
      const id = `a${copied.size + 1}`;
      copy = {
        id,
        source: { conversationSourceId: sourceId, kind, reference },
        references: [],
      };
      copied.set(key, copy);
      attachments.push({
        id,
        kind,
        fileName: typeof reference.fileName === 'string' ? reference.fileName : id,
        objectId: id,
      });
    }
    copy.references.push(reference);
  }

  function visit(value: ShareJson, sourceId: string): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, sourceId);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (
      value.type === 'file' &&
      !(options.fileAttachmentsEnabled ?? SESSION_SHARE_FILE_ATTACHMENTS_ENABLED)
    ) {
      // Replace the detached display block, never read the original file or retain
      // its source IDs, paths, metadata, or nested content in the published copy.
      for (const key of Object.keys(value)) delete value[key];
      value.type = 'text';
      value.text =
        options.fileAttachmentOmissionText ?? 'File attachment not included in this share';
      return;
    }
    if (value.type === 'image' && typeof value.imageId === 'string') {
      copyAttachment(value, 'image', sourceId);
    } else if (value.type === 'file' && typeof value.fileId === 'string') {
      copyAttachment(value, 'file', sourceId);
    } else if (value.type === 'image_group' && Array.isArray(value.images)) {
      for (const image of value.images) {
        if (!image || typeof image !== 'object' || Array.isArray(image))
          throw new Error('Invalid share attachment');
        copyAttachment(image, 'image', sourceId);
      }
    }
    // Known display containers only. rawInput/rawOutput/_meta are inert history,
    // not a license to fetch URLs or reinterpret arbitrary objects as attachments.
    for (const key of ['items', 'content', 'inputBlocks']) {
      const child = value[key];
      if (child !== undefined) visit(child, sourceId);
    }
  }

  for (const source of captured) {
    for (const entry of source.history) {
      if (entry.items !== undefined) visit(entry.items, source.sourceId);
      const config = entry.inputConfig;
      if (
        config &&
        typeof config === 'object' &&
        !Array.isArray(config) &&
        config.inputBlocks !== undefined
      ) {
        visit(config.inputBlocks, source.sourceId);
      }
    }
  }
  await mapShareConcurrent(
    [...copied.values()],
    async (copy, _index, signal) => {
      const loaded = await options.readAttachment(copy.source, signal);
      const descriptor = await addObject(copy.id, loaded.bytes, loaded.mediaType);
      for (const reference of copy.references) {
        if (typeof reference.sha256 === 'string' && descriptor.sha256 !== reference.sha256)
          throw new Error('Share attachment checksum mismatch');
        reference[copy.source.kind === 'image' ? 'imageId' : 'fileId'] = copy.id;
        reference.sizeBytes = descriptor.sizeBytes;
        reference.mimeType = loaded.mediaType;
        delete reference.storageSessionId;
        delete reference.machineId;
        delete reference.sourcePath;
        if (copy.source.kind === 'file') reference.transport = 'r2';
      }
    },
    options.signal
  );
  const histories = await mapShareConcurrent(
    captured,
    async (source, index, signal) => {
      const historyObjectId = `h${index + 1}`;
      const raw = encodeShareJson(source.history, SHARE_LIMITS.historyBytes);
      const compressed = options.compressHistory ? await options.compressHistory(raw) : raw;
      signal.throwIfAborted();
      const useCompressed = compressed.length < raw.length;
      await addObject(
        historyObjectId,
        useCompressed ? compressed : raw,
        'application/json',
        useCompressed ? { contentEncoding: 'zstd', decodedSizeBytes: raw.length } : undefined
      );
      const parent =
        source.parentSourceId && selected.has(source.parentSourceId)
          ? ids.get(source.parentSourceId)
          : undefined;
      const opener =
        source.openedBySourceId && selected.has(source.openedBySourceId)
          ? ids.get(source.openedBySourceId)
          : undefined;
      return {
        id: source.id,
        title: source.title,
        historyObjectId,
        ...(parent ? { parentConversationId: parent } : {}),
        ...(opener ? { openedByConversationId: opener } : {}),
        ...(parent && source.childSessionPlacement
          ? { childSessionPlacement: source.childSessionPlacement }
          : {}),
      };
    },
    options.signal
  );
  conversations.push(...histories);
  // Completion order is not identity or manifest order.
  inventory.sort((a, b) => a.id.localeCompare(b.id));
  const manifest = SharePackageManifestSchema.parse({
    formatVersion: options.compressHistory ? 2 : 1,
    historyFormatVersion: 1,
    capturedAt: options.capturedAt,
    rootConversationId: ids.get(options.rootSourceId),
    conversations,
    attachments,
    objects: inventory,
  });
  const manifestBytes = encodeShareJson(manifest, SHARE_LIMITS.manifestBytes);
  return {
    manifest,
    manifestBytes,
    manifestHash: await shareObjectDigest(manifestBytes),
    objects,
    sourceIds: captured.map((source) => ({ sourceId: source.sourceId, conversationId: source.id })),
  };
}
