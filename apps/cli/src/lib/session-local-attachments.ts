import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionLocalAttachment } from '@lody/shared';
import { SessionLocalAttachmentSchema } from '@lody/shared/message-schemas';

export type LocalAttachmentScope = {
  workspaceId: string;
  machineId: string;
  sessionId: string;
  turnId: string;
};
type Registration = LocalAttachmentScope & {
  referenceId: string;
  path: string;
  managed: boolean;
  kind: 'file' | 'image';
  fileName: string;
  mimeType: string;
};
type Record = {
  version: 1;
  scope: LocalAttachmentScope;
  originalPath: string;
  canonicalPath: string;
  managed: boolean;
  sourceHash?: string;
  attachment: SessionLocalAttachment;
};
const key = (scope: LocalAttachmentScope, id: string) =>
  createHash('sha256')
    .update(JSON.stringify([scope.workspaceId, scope.machineId, scope.sessionId, scope.turnId, id]))
    .digest('hex');
function recordPath(root: string, scope: LocalAttachmentScope, id: string) {
  return path.join(root, key(scope, id) + '.json');
}
async function readableFile(file: string) {
  if (!path.isAbsolute(file)) throw new Error('Attachment requires an absolute path');
  const canonical = await fs.realpath(file);
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error('Attachment is not a regular file');
  await fs.access(canonical, constants.R_OK);
  return { canonical, size: stat.size };
}
/** Only the authenticated local control boundary may register a user-selected path. */
export async function registerLocalAttachment(
  root: string,
  input: Registration
): Promise<SessionLocalAttachment> {
  const scope = {
    workspaceId: input.workspaceId,
    machineId: input.machineId,
    sessionId: input.sessionId,
    turnId: input.turnId,
  };
  const source = await readableFile(input.path);
  const attachment = SessionLocalAttachmentSchema.parse({
    type: 'local_attachment',
    referenceId: input.referenceId,
    machineId: input.machineId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: input.kind,
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: source.size,
  });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = recordPath(root, scope, input.referenceId);
  if (input.managed && source.size > 100 * 1024 * 1024)
    throw new Error('Generated attachment exceeds local storage limit');
  const sourceHash = input.managed
    ? createHash('sha256')
        .update(await fs.readFile(source.canonical))
        .digest('hex')
    : undefined;
  try {
    const saved = JSON.parse(await fs.readFile(metadata, 'utf8')) as Record;
    if (
      saved.sourceHash !== sourceHash ||
      saved.managed !== input.managed ||
      (!input.managed && saved.originalPath !== input.path) ||
      saved.attachment.kind !== input.kind ||
      saved.attachment.fileName !== input.fileName
    )
      throw new Error('Attachment registration conflicts with its original source');
    await resolveLocalAttachment(root, scope, saved.attachment);
    return saved.attachment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let canonicalPath = source.canonical;
  if (input.managed) {
    if (source.size > 100 * 1024 * 1024)
      throw new Error('Generated attachment exceeds local storage limit');
    canonicalPath = path.join(root, key(scope, input.referenceId) + '.data');
    // Each registration has an immutable destination. A retry never replaces accepted bytes.
    try {
      await fs.copyFile(source.canonical, canonicalPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    canonicalPath = await fs.realpath(canonicalPath);
    if (
      createHash('sha256')
        .update(await fs.readFile(canonicalPath))
        .digest('hex') !== sourceHash
    )
      throw new Error('Attachment registration conflicts with staged content');
  }
  const record: Record = {
    version: 1,
    scope,
    originalPath: input.managed ? canonicalPath : input.path,
    canonicalPath,
    managed: input.managed,
    sourceHash,
    attachment,
  };
  const temporary = metadata + '.' + randomUUID();
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await fs.unlink(temporary);
  }
  await resolveLocalAttachment(root, scope, attachment);
  return attachment;
}
export async function resolveLocalAttachment(
  root: string,
  scope: LocalAttachmentScope,
  attachment: SessionLocalAttachment
) {
  SessionLocalAttachmentSchema.parse(attachment);
  if (
    attachment.machineId !== scope.machineId ||
    attachment.sessionId !== scope.sessionId ||
    attachment.turnId !== scope.turnId
  )
    throw new Error('Local attachment belongs to another execution scope');
  const saved = JSON.parse(
    await fs.readFile(recordPath(root, scope, attachment.referenceId), 'utf8')
  ) as Record;
  if (
    saved.version !== 1 ||
    key(saved.scope, attachment.referenceId) !== key(scope, attachment.referenceId) ||
    JSON.stringify(SessionLocalAttachmentSchema.parse(saved.attachment)) !==
      JSON.stringify(SessionLocalAttachmentSchema.parse(attachment))
  )
    throw new Error('Invalid local attachment registration');
  const current = await readableFile(saved.originalPath);
  if (current.canonical !== saved.canonicalPath)
    throw new Error('Local attachment path changed; select the file again');
  return { path: current.canonical, sizeBytes: current.size };
}

/** Called only after a resend/fork operation has authorized its source history. */
export async function rebindLocalAttachment(
  root: string,
  source: LocalAttachmentScope,
  target: LocalAttachmentScope,
  attachment: SessionLocalAttachment
): Promise<SessionLocalAttachment> {
  if (source.machineId !== target.machineId || source.workspaceId !== target.workspaceId)
    throw new Error('Local attachments cannot be inherited by another execution environment');
  await resolveLocalAttachment(root, source, attachment);
  const saved = JSON.parse(
    await fs.readFile(recordPath(root, source, attachment.referenceId), 'utf8')
  ) as Record;
  const rebound: SessionLocalAttachment = {
    ...attachment,
    sessionId: target.sessionId,
    turnId: target.turnId,
  };
  const record: Record = { ...saved, scope: target, attachment: rebound };
  const destination = recordPath(root, target, rebound.referenceId);
  const temporary = destination + '.' + randomUUID();
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await fs.unlink(temporary);
  }
  const resolved = await resolveLocalAttachment(root, target, rebound);
  if (resolved.path !== saved.canonicalPath)
    throw new Error('Local attachment inheritance conflicts with an existing registration');
  return rebound;
}
