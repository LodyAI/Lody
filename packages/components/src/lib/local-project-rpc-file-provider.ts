import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectDirectoryListResult,
  LocalProjectFileListResult,
  LocalProjectFileReadResult,
  LocalProjectId,
  MachineId,
  WorkspaceId,
} from '@lody/shared';
import { isBinaryImagePath, SESSION_IMAGE_MAX_SIZE_BYTES } from '@lody/shared';
import {
  LazyDirectoryFileProvider,
  joinProjectPath,
  toDirectoryEntry,
  toFileEntry,
} from './lazy-directory-file-provider';
import { base64ToBytes } from './base64';
import { getIpcServices } from './electron-ipc-client';
import type {
  FileWorkspaceOpenResult,
  FileWorkspaceProviderEntry,
} from './file-workspace-provider';

const DEFAULT_LIST_DIR_LIMIT = 1_000;
const DEFAULT_SEARCH_MAX_FILES = 80_000;
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;

export type LocalProjectFileTransport = {
  listDir: (args: {
    readonly relativePath: string;
    readonly limit?: number;
  }) => Promise<LocalProjectDirectoryListResult>;
  listFiles: (args?: { readonly maxFiles?: number }) => Promise<LocalProjectFileListResult>;
  readFile: (args: {
    readonly relativePath: string;
    readonly maxBytes?: number;
  }) => Promise<LocalProjectFileReadResult | null>;
};

export type LocalProjectRpcFileProviderOptions = {
  readonly transport: LocalProjectFileTransport;
};

export function assertLocalProjectControlResponse<TType extends LocalProjectControlRequest['type']>(
  response: LocalProjectControlResponse | null,
  expectedType: TType
): Extract<LocalProjectControlResponse, { ok: true; type: TType }> {
  if (!response) {
    throw new Error('Local project machine did not respond.');
  }
  if (!response.ok) {
    throw new Error(response.message);
  }
  if (response.type !== expectedType) {
    throw new Error(`Unexpected response type: ${response.type}`);
  }
  return response as Extract<LocalProjectControlResponse, { ok: true; type: TType }>;
}

export function createLocalProjectIpcFileTransport(args: {
  readonly workspaceId: WorkspaceId;
  readonly localProjectId: LocalProjectId;
}): LocalProjectFileTransport {
  return {
    listDir: async ({ relativePath, limit }) => {
      const result = await getIpcServices()?.localProjects.listDir(
        args.workspaceId,
        args.localProjectId,
        relativePath,
        { limit }
      );
      if (!result) {
        throw new Error('Local project directory IPC is unavailable.');
      }
      return result;
    },
    listFiles: async ({ maxFiles } = {}) => {
      const result = await getIpcServices()?.localProjects.listFiles(
        args.workspaceId,
        args.localProjectId,
        { maxFiles }
      );
      if (!result) {
        throw new Error('Local project file IPC is unavailable.');
      }
      return result;
    },
    readFile: async ({ relativePath, maxBytes }) => {
      if (!getIpcServices()) {
        throw new Error('Local project file IPC is unavailable.');
      }
      return await getIpcServices()!.localProjects.readFile(
        args.workspaceId,
        args.localProjectId,
        relativePath,
        { maxBytes }
      );
    },
  };
}

export function createLocalProjectRpcFileTransport(args: {
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  readonly localProjectId: LocalProjectId;
  readonly requestedByUserId: string;
  readonly requestLocalProjectControl: (
    request: LocalProjectControlRequest,
    options?: { timeoutMs?: number }
  ) => Promise<LocalProjectControlResponse | null>;
}): LocalProjectFileTransport {
  return {
    listDir: async ({ relativePath, limit }) => {
      const response = await args.requestLocalProjectControl(
        {
          type: 'local-project/list-dir',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          localProjectId: args.localProjectId,
          relativePath,
          limit,
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return assertLocalProjectControlResponse(response, 'local-project/list-dir').result;
    },
    listFiles: async ({ maxFiles } = {}) => {
      const response = await args.requestLocalProjectControl(
        {
          type: 'local-project/list-files',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          localProjectId: args.localProjectId,
          maxFiles,
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return assertLocalProjectControlResponse(response, 'local-project/list-files').result;
    },
    readFile: async ({ relativePath, maxBytes }) => {
      const response = await args.requestLocalProjectControl(
        {
          type: 'local-project/read-file',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          localProjectId: args.localProjectId,
          relativePath,
          maxBytes,
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return assertLocalProjectControlResponse(response, 'local-project/read-file').result;
    },
  };
}

export class LocalProjectRpcFileProvider extends LazyDirectoryFileProvider {
  constructor(private readonly options: LocalProjectRpcFileProviderOptions) {
    super();
  }

  async searchFiles(query: string): Promise<readonly FileWorkspaceProviderEntry[]> {
    const normalized = query.trim().toLowerCase();
    const result = await this.options.transport.listFiles({ maxFiles: DEFAULT_SEARCH_MAX_FILES });
    const paths = normalized
      ? result.paths.filter((path) => path.toLowerCase().includes(normalized))
      : result.paths;
    return paths.map((path) => toFileEntry(path));
  }

  async openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult> {
    // Images are read as raw bytes (base64 over the wire); allow a larger budget
    // than text so typical screenshots/photos fit. SVG stays text.
    const isImage = isBinaryImagePath(pathOrFileId);
    const result = await this.options.transport.readFile({
      relativePath: pathOrFileId,
      maxBytes: isImage ? SESSION_IMAGE_MAX_SIZE_BYTES : DEFAULT_READ_MAX_BYTES,
    });
    if (!result) {
      return {
        status: 'unavailable',
        reason: 'metadata-only',
        message: 'File is unavailable.',
      };
    }

    const entry = this.entries.get(result.path) ?? toFileEntry(result.path);
    this.entries.set(result.path, entry);

    if (result.encoding === 'base64') {
      // A truncated image is a corrupt blob, so omit the bytes and let the UI
      // render a "too large to preview" notice instead of a partial image.
      if (result.truncated) {
        return { status: 'ready', entry, snapshot: { kind: 'binary' } };
      }
      return {
        status: 'ready',
        entry,
        snapshot: { kind: 'binary', bytes: base64ToBytes(result.content) },
      };
    }

    return {
      status: 'ready',
      entry,
      snapshot: {
        kind: 'text',
        text: result.content,
        ...(result.truncated ? { truncated: true } : {}),
      },
    };
  }

  protected async loadDirectoryEntries(
    relativePath: string
  ): Promise<readonly FileWorkspaceProviderEntry[]> {
    const result = await this.options.transport.listDir({
      relativePath,
      limit: DEFAULT_LIST_DIR_LIMIT,
    });
    return result.entries.map((child) => {
      const childPath = joinProjectPath(relativePath, child.name);
      return child.type === 'directory' ? toDirectoryEntry(childPath) : toFileEntry(childPath);
    });
  }
}
