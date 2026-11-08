import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  FILE_DOWNLOAD_CHUNK_BYTES,
  FILE_DOWNLOAD_MAX_BYTES,
  type FileDownloadRequest,
  type FileDownloadResponse,
} from '@lody/shared';
import * as fs from 'node:fs/promises';
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
  attachment: SessionLocalAttachment;
};
const key = (scope: LocalAttachmentScope, id: string) =>
  createHash('sha256')
    .update(JSON.stringify([scope.workspaceId, scope.machineId, scope.sessionId, scope.turnId, id]))
    .digest('hex');
function recordPath(root: string, scope: LocalAttachmentScope, id: string) {
  return path.join(root, key(scope, id) + '.json');
}
async function regularFile(file: string) {
  if (!path.isAbsolute(file)) throw new Error('Attachment requires an absolute path');
  const canonical = await fs.realpath(file);
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error('Attachment is not a regular file');
  return { canonical, size: stat.size };
}
type Usage = Pick<LocalAttachmentScope, 'sessionId' | 'turnId'>;
type Environment = Pick<LocalAttachmentScope, 'workspaceId' | 'machineId'> & { accountId: string };

/** One account/workspace/machine attachment store. Callers authorize session operations. */
export class LocalAttachmentStore {
  private readonly root: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  private write<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(work, work);
    this.writeChain = run.catch(() => undefined);
    return run;
  }
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
    return this.write(() => this.registerNew(input));
  }

  private async registerNew(input: Omit<Registration, 'workspaceId' | 'machineId'>) {
    const root = this.root;
    const scope = this.scope(input);
    const accepted = await this.readRecord(scope, input.referenceId);
    if (accepted) return accepted.attachment;
    const source = await regularFile(input.path);
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
    let canonicalPath = source.canonical;
    if (input.managed) {
      canonicalPath = path.join(root, key(scope, input.referenceId) + '.data');
      await publishFile(canonicalPath, await fs.readFile(source.canonical));
      canonicalPath = await fs.realpath(canonicalPath);
    }
    const record: Record = {
      version: 1,
      scope,
      originalPath: input.managed ? canonicalPath : input.path,
      canonicalPath,
      managed: input.managed,
      attachment,
    };
    await publishFile(metadata, JSON.stringify(record));
    return attachment;
  }
  async resolve(usage: Usage, attachment: SessionLocalAttachment) {
    return (await this.resolveRegistration(usage, attachment)).resolved;
  }

  private async resolveRegistration(usage: Usage, attachment: SessionLocalAttachment) {
    const scope = this.scope(usage);
    if (
      attachment.machineId !== scope.machineId ||
      attachment.sessionId !== scope.sessionId ||
      attachment.turnId !== scope.turnId
    )
      throw new Error('Local attachment belongs to another execution scope');
    const saved = await this.readRecord(scope, attachment.referenceId);
    if (!saved) throw Object.assign(new Error('Local attachment not found'), { code: 'ENOENT' });
    const current = await regularFile(saved.originalPath);
    if (current.canonical !== saved.canonicalPath)
      throw new Error('Local attachment path changed; select the file again');
    return { saved, resolved: { path: current.canonical, sizeBytes: current.size } };
  }

  private async readRecord(
    scope: LocalAttachmentScope,
    referenceId: string
  ): Promise<Record | null> {
    let raw: string;
    try {
      raw = await fs.readFile(recordPath(this.root, scope, referenceId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const saved = JSON.parse(raw) as Record;
    if (
      saved.version !== 1 ||
      key(saved.scope, referenceId) !== key(scope, referenceId) ||
      saved.attachment.referenceId !== referenceId
    )
      throw new Error('Invalid local attachment registration');
    return saved;
  }

  /** Called only after a resend/fork operation has authorized its source history. */
  async inherit(
    attachment: SessionLocalAttachment,
    targetUsage: Usage
  ): Promise<SessionLocalAttachment> {
    return this.write(async () => {
      const target = this.scope(targetUsage);
      const { saved } = await this.resolveRegistration(attachment, attachment);
      const accepted = await this.readRecord(target, attachment.referenceId);
      if (accepted) return accepted.attachment;
      const rebound: SessionLocalAttachment = {
        ...saved.attachment,
        sessionId: target.sessionId,
        turnId: target.turnId,
      };
      const record: Record = { ...saved, scope: target, attachment: rebound };
      await publishFile(recordPath(this.root, target, rebound.referenceId), JSON.stringify(record));
      return rebound;
    });
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

async function publishFile(destination: string, bytes: string | Uint8Array) {
  const temporary = destination + '.' + randomUUID();
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}
