import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  FILE_DOWNLOAD_CHUNK_BYTES,
  FILE_DOWNLOAD_MAX_BYTES,
  type FileDownloadRequest,
  type FileDownloadResponse,
} from '@lody/shared';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionLocalAttachment } from '@lody/shared';
import { SessionLocalAttachmentSchema } from '@lody/shared/message-schemas';

type LocalAttachmentScope = {
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
type Usage = Pick<LocalAttachmentScope, 'sessionId' | 'turnId'>;
type Environment = Pick<LocalAttachmentScope, 'workspaceId' | 'machineId'> & { accountId: string };

/** One account/workspace/machine attachment store. Callers authorize session operations. */
export class LocalAttachmentStore {
  private readonly root: string;
  constructor(
    private readonly environment: Environment,
    dataDir = getLodyDataDir()
  ) {
    this.root = path.join(
      dataDir,
      'local-attachments',
      createHash('sha256').update(environment.accountId).digest('hex')
    );
  }
  private scope(usage: Usage): LocalAttachmentScope {
    return {
      workspaceId: this.environment.workspaceId,
      machineId: this.environment.machineId,
      sessionId: usage.sessionId,
      turnId: usage.turnId,
    };
  }

  /** Only the authenticated local control boundary may register a user-selected path. */
  async register(
    input: Omit<Registration, 'workspaceId' | 'machineId'>
  ): Promise<SessionLocalAttachment> {
    const root = this.root;
    const scope = this.scope(input);
    const source = await readableFile(input.path);
    const attachment = SessionLocalAttachmentSchema.parse({
      type: 'local_attachment',
      referenceId: input.referenceId,
      machineId: scope.machineId,
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
      await this.resolve(scope, saved.attachment);
      return saved.attachment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let canonicalPath = source.canonical;
    if (input.managed) {
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
    await publishRecord(metadata, record);
    await this.resolve(scope, attachment);
    return attachment;
  }
  async resolve(usage: Usage, attachment: SessionLocalAttachment) {
    const root = this.root;
    const scope = this.scope(usage);
    const parsedAttachment = SessionLocalAttachmentSchema.parse(attachment);
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
        JSON.stringify(parsedAttachment)
    )
      throw new Error('Invalid local attachment registration');
    const current = await readableFile(saved.originalPath);
    if (current.canonical !== saved.canonicalPath)
      throw new Error('Local attachment path changed; select the file again');
    return { path: current.canonical, sizeBytes: current.size };
  }

  /** Called only after a resend/fork operation has authorized its source history. */
  async inherit(
    attachment: SessionLocalAttachment,
    targetUsage: Usage
  ): Promise<SessionLocalAttachment> {
    const root = this.root;
    const source = this.scope(attachment);
    const target = this.scope(targetUsage);
    await this.resolve(source, attachment);
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
    await publishRecord(destination, record);
    const resolved = await this.resolve(target, rebound);
    if (resolved.path !== saved.canonicalPath)
      throw new Error('Local attachment inheritance conflicts with an existing registration');
    return rebound;
  }

  /** Explicit downloads reuse the authenticated file RPC and its bounded chunk format. */
  async download(request: FileDownloadRequest): Promise<FileDownloadResponse> {
    if (!request.attachment) return { status: 'error', code: 'invalid_path' };
    try {
      const resolved = await this.resolve(
        { sessionId: request.sessionId, turnId: request.attachment.turnId },
        request.attachment
      );
      const file = await fs.open(resolved.path, 'r');
      try {
        const stat = await file.stat();
        if (stat.size > FILE_DOWNLOAD_MAX_BYTES) return { status: 'error', code: 'too_large' };
        // The existing download protocol uses a metadata revision, not a content hash.
        const revision = createHash('sha256')
          .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]))
          .digest('hex');
        if (request.offset > stat.size || (request.revision && request.revision !== revision))
          return { status: 'error', code: 'file_changed' };
        const bytes = Buffer.alloc(Math.min(FILE_DOWNLOAD_CHUNK_BYTES, stat.size - request.offset));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, request.offset);
        return {
          status: 'ok',
          path: request.attachment.fileName,
          revision,
          sizeBytes: stat.size,
          offset: request.offset,
          data: bytes.subarray(0, bytesRead).toString('base64'),
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      return {
        status: 'error',
        code:
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_not_found' : 'transient_io',
      };
    }
  }
}

async function publishRecord(destination: string, record: Record) {
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
}
