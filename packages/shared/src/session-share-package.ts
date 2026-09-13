import { z } from 'zod';

/** Product rollout switch, shared by capture and publication authorization. */
export const SESSION_SHARE_FILE_ATTACHMENTS_ENABLED: boolean = false;

export function assertShareAttachmentPolicy(manifest: SharePackageManifest): void {
  if (
    !SESSION_SHARE_FILE_ATTACHMENTS_ENABLED &&
    manifest.attachments.some((a) => a.kind === 'file')
  )
    throw new Error('share_file_attachments_disabled');
}

/** Portable published data, deliberately independent of Loro and workspace auth. */
export const SHARE_LIMITS = {
  conversations: 32,
  attachments: 512,
  manifestBytes: 1024 * 1024,
  historyBytes: 32 * 1024 * 1024,
  objectBytes: 100 * 1024 * 1024,
  deploymentBytes: 256 * 1024 * 1024,
  jsonDepth: 64,
} as const;

export const ShareResourceId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const ShareDigest = z.string().regex(/^[a-f0-9]{64}$/);
const title = z.string().refine((value) => new TextEncoder().encode(value).length <= 1024);
export const ShareObjectSchema = z
  .object({
    id: ShareResourceId,
    mediaType: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.+-]+\/[\w.+-]+$/),
    sizeBytes: z.number().int().min(0).max(SHARE_LIMITS.objectBytes),
    sha256: ShareDigest,
  })
  .strict();
export const ShareConversationSchema = z
  .object({
    id: ShareResourceId,
    title,
    historyObjectId: ShareResourceId,
    parentConversationId: ShareResourceId.optional(),
    openedByConversationId: ShareResourceId.optional(),
    childSessionPlacement: z.literal('side-panel').optional(),
  })
  .strict();
export const ShareAttachmentSchema = z
  .object({
    id: ShareResourceId,
    kind: z.enum(['image', 'file']),
    fileName: z.string().max(1024),
    objectId: ShareResourceId,
  })
  .strict();

export const SharePackageManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    historyFormatVersion: z.literal(1),
    capturedAt: z.string().datetime(),
    rootConversationId: ShareResourceId,
    conversations: z.array(ShareConversationSchema).min(1).max(SHARE_LIMITS.conversations),
    attachments: z.array(ShareAttachmentSchema).max(SHARE_LIMITS.attachments),
    objects: z
      .array(ShareObjectSchema)
      .min(1)
      .max(SHARE_LIMITS.conversations + SHARE_LIMITS.attachments),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const invalid = () => ctx.addIssue({ code: 'custom', message: 'Invalid share inventory' });
    const conversations = new Map(manifest.conversations.map((entry) => [entry.id, entry]));
    const objects = new Map(manifest.objects.map((entry) => [entry.id, entry]));
    const referenced = new Set<string>();
    if (
      conversations.size !== manifest.conversations.length ||
      objects.size !== manifest.objects.length ||
      !conversations.has(manifest.rootConversationId) ||
      new Set(manifest.attachments.map((entry) => entry.id)).size !== manifest.attachments.length
    )
      invalid();
    if (
      manifest.objects.reduce((total, entry) => total + entry.sizeBytes, 0) >
      SHARE_LIMITS.deploymentBytes
    )
      invalid();
    // The UI resolves a Tab's owner before following its opener. Validate the
    // combined graph, not just two individually acyclic relation lists.
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      const entry = conversations.get(id);
      if (!entry) return false;
      visiting.add(id);
      for (const target of [entry.parentConversationId, entry.openedByConversationId]) {
        if (target && !visit(target)) return false;
      }
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    for (const entry of manifest.conversations)
      if (!visit(entry.id)) {
        invalid();
        break;
      }
    for (const conversation of manifest.conversations) {
      const object = objects.get(conversation.historyObjectId);
      if (
        !object ||
        object.mediaType !== 'application/json' ||
        object.sizeBytes > SHARE_LIMITS.historyBytes
      )
        invalid();
      referenced.add(conversation.historyObjectId);
      if (conversation.childSessionPlacement && !conversation.parentConversationId) invalid();
      if (
        conversation.parentConversationId &&
        conversations.get(conversation.parentConversationId)?.parentConversationId
      )
        invalid();
    }
    for (const attachment of manifest.attachments) {
      if (!objects.has(attachment.objectId)) invalid();
      referenced.add(attachment.objectId);
    }
    if (referenced.size !== objects.size) invalid();
  });

export type SharePackageManifest = z.infer<typeof SharePackageManifestSchema>;
export type ShareConversation = z.infer<typeof ShareConversationSchema>;
export type ShareObject = z.infer<typeof ShareObjectSchema>;
export type ShareAttachment = z.infer<typeof ShareAttachmentSchema>;
export type ShareJson =
  | null
  | boolean
  | number
  | string
  | ShareJson[]
  | { [key: string]: ShareJson };
export type ShareHistoryEntry = { [key: string]: ShareJson } & {
  id: string;
  role: string;
  items?: ({ [key: string]: ShareJson } & { type: string })[];
};

/** Validate JSON without rewriting unknown persisted fields. No diagnostic includes content. */
function assertJson(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>()
): asserts value is ShareJson {
  if (depth > SHARE_LIMITS.jsonDepth) throw new Error('Share JSON exceeds depth limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw new Error('Invalid share JSON');
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error('Invalid share JSON');
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertJson(child, depth + 1, ancestors);
  ancestors.delete(value);
}

/** A storage contract, not the evolving live message parser. Unknown message types survive. */
export function validateShareHistory(value: unknown): ShareHistoryEntry[] {
  assertJson(value);
  if (!Array.isArray(value)) throw new Error('Invalid share history');
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      ids.has(entry.id) ||
      typeof entry.role !== 'string' ||
      (entry.items !== undefined &&
        (!Array.isArray(entry.items) ||
          entry.items.some(
            (item) =>
              !item ||
              typeof item !== 'object' ||
              Array.isArray(item) ||
              typeof item.type !== 'string'
          )))
    )
      throw new Error('Invalid share history');
    ids.add(entry.id);
  }
  return value as ShareHistoryEntry[];
}

export function encodeShareJson(value: unknown, limit: number): Uint8Array {
  assertJson(value);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > limit) throw new Error('Share object exceeds size limit');
  return bytes;
}

export async function shareObjectDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyShareObject(bytes: Uint8Array, descriptor: ShareObject): Promise<void> {
  if (
    bytes.byteLength !== descriptor.sizeBytes ||
    (await shareObjectDigest(bytes)) !== descriptor.sha256
  ) {
    throw new Error('Invalid share object');
  }
}

/** Only validated opaque identifiers can select storage. Never accept caller supplied keys. */
export function shareObjectKey(shareId: string, deploymentId: string, objectId: string): string {
  return `shares/${ShareResourceId.parse(shareId)}/${ShareResourceId.parse(deploymentId)}/objects/${ShareResourceId.parse(objectId)}`;
}

export function shareManifestKey(shareId: string, deploymentId: string): string {
  return `shares/${ShareResourceId.parse(shareId)}/${ShareResourceId.parse(deploymentId)}/manifest.json`;
}
