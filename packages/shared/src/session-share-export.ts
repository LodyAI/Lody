import {
  SHARE_LIMITS,
  SharePackageManifestSchema,
  ShareResourceId,
  encodeShareJson,
  shareObjectDigest,
  validateShareHistory,
  type ShareAttachment,
  type ShareConversation,
  type ShareHistoryEntry,
  type ShareJson,
  type ShareObject,
  type SharePackageManifest,
} from './session-share-package';

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
  /** Preflight only, not persisted. Opaque history links are text, never fetch authority. */
  uncopiedResourceCount: number;
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
  readAttachment: (
    source: ShareAttachmentSource,
    signal?: AbortSignal
  ) => Promise<{
    bytes: Uint8Array;
    mediaType: string;
  }>;
  signal?: AbortSignal;
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
    const bytes = encodeShareJson(validateShareHistory(source.history), SHARE_LIMITS.historyBytes);
    capturedBytes += bytes.length;
    if (capturedBytes > SHARE_LIMITS.deploymentBytes)
      throw new Error('Share package exceeds size limit');
    const history = validateShareHistory(JSON.parse(new TextDecoder().decode(bytes)));
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
    { id: string; sizeBytes: number; mediaType: string; sha256: string }
  >();
  let totalBytes = 0;
  let uncopiedResourceCount = 0;
  async function addObject(id: string, bytes: Uint8Array, mediaType: string) {
    options.signal?.throwIfAborted();
    if (bytes.length > SHARE_LIMITS.objectBytes) throw new Error('Share object exceeds size limit');
    totalBytes += bytes.length;
    if (totalBytes > SHARE_LIMITS.deploymentBytes)
      throw new Error('Share package exceeds size limit');
    // Own the bytes: a host cache cannot mutate the confirmed artifact later.
    const owned = bytes.slice();
    inventory.push({
      id,
      mediaType,
      sizeBytes: owned.length,
      sha256: await shareObjectDigest(owned),
    });
    objects.set(id, owned);
  }

  async function copyAttachment(
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
      if (attachments.length >= SHARE_LIMITS.attachments)
        throw new Error('Too many share attachments');
      options.signal?.throwIfAborted();
      const loaded = await options.readAttachment(
        { conversationSourceId: sourceId, kind, reference },
        options.signal
      );
      const id = `a${attachments.length + 1}`;
      await addObject(id, loaded.bytes, loaded.mediaType);
      copy = {
        id,
        sizeBytes: loaded.bytes.length,
        mediaType: loaded.mediaType,
        sha256: inventory[inventory.length - 1]!.sha256,
      };
      copied.set(key, copy);
      attachments.push({
        id,
        kind,
        fileName: typeof reference.fileName === 'string' ? reference.fileName : id,
        objectId: id,
      });
    }
    if (typeof reference.sha256 === 'string' && copy.sha256 !== reference.sha256) {
      throw new Error('Share attachment checksum mismatch');
    }
    reference[kind === 'image' ? 'imageId' : 'fileId'] = copy.id;
    reference.sizeBytes = copy.sizeBytes;
    reference.mimeType = copy.mediaType;
    delete reference.storageSessionId;
    delete reference.machineId;
    delete reference.sourcePath;
    if (kind === 'file') reference.transport = 'r2';
  }

  async function visit(value: ShareJson, sourceId: string): Promise<void> {
    if (Array.isArray(value)) {
      for (const child of value) await visit(child, sourceId);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (
      (value.type === 'resource_link' && typeof value.uri === 'string') ||
      (value.type === 'image' &&
        typeof value.uri === 'string' &&
        typeof value.imageId !== 'string' &&
        typeof value.data !== 'string')
    ) {
      uncopiedResourceCount++;
    }
    if (value.type === 'text' && typeof value.text === 'string') {
      // Do not parse/fetch arbitrary Markdown or tool output with workspace credentials.
      // The reader intentionally renders these external media references inert.
      uncopiedResourceCount += [
        ...value.text.matchAll(
          /!\[[^\]]*\]\((?!data:)[^)]+\)|(?:file:\/\/|lody-file:|\/api\/workspaces\/)/g
        ),
      ].length;
    }
    if (value.type === 'image' && typeof value.imageId === 'string') {
      await copyAttachment(value, 'image', sourceId);
    } else if (value.type === 'file' && typeof value.fileId === 'string') {
      await copyAttachment(value, 'file', sourceId);
    } else if (value.type === 'image_group' && Array.isArray(value.images)) {
      for (const image of value.images) {
        if (!image || typeof image !== 'object' || Array.isArray(image))
          throw new Error('Invalid share attachment');
        await copyAttachment(image, 'image', sourceId);
      }
    }
    // Known display containers only. rawInput/rawOutput/_meta are inert history,
    // not a license to fetch URLs or reinterpret arbitrary objects as attachments.
    for (const key of ['items', 'content', 'inputBlocks']) {
      const child = value[key];
      if (child !== undefined) await visit(child, sourceId);
    }
  }

  for (const source of captured) {
    for (const entry of source.history) {
      if (entry.items !== undefined) await visit(entry.items, source.sourceId);
      const config = entry.inputConfig;
      if (
        config &&
        typeof config === 'object' &&
        !Array.isArray(config) &&
        config.inputBlocks !== undefined
      ) {
        await visit(config.inputBlocks, source.sourceId);
      }
    }
    const historyObjectId = `h${conversations.length + 1}`;
    await addObject(
      historyObjectId,
      encodeShareJson(source.history, SHARE_LIMITS.historyBytes),
      'application/json'
    );
    const parent =
      source.parentSourceId && selected.has(source.parentSourceId)
        ? ids.get(source.parentSourceId)
        : undefined;
    const opener =
      source.openedBySourceId && selected.has(source.openedBySourceId)
        ? ids.get(source.openedBySourceId)
        : undefined;
    conversations.push({
      id: source.id,
      title: source.title,
      historyObjectId,
      ...(parent ? { parentConversationId: parent } : {}),
      ...(opener ? { openedByConversationId: opener } : {}),
      ...(parent && source.childSessionPlacement
        ? { childSessionPlacement: source.childSessionPlacement }
        : {}),
    });
  }
  const manifest = SharePackageManifestSchema.parse({
    formatVersion: 1,
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
    uncopiedResourceCount,
  };
}

export function readPreparedShareHistory(
  prepared: PreparedSharePackage,
  conversationId: string
): ShareHistoryEntry[] {
  const conversation = prepared.manifest.conversations.find((entry) => entry.id === conversationId);
  const bytes = conversation && prepared.objects.get(conversation.historyObjectId);
  if (!bytes) throw new Error('Share conversation unavailable');
  return validateShareHistory(JSON.parse(new TextDecoder().decode(bytes)));
}
