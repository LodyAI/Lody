import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectDirectoryListResult,
  LocalProjectFileListResult,
  LocalProjectFileReadResult,
  LocalProjectFileSearchResult,
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
export const DEFAULT_LOCAL_PROJECT_SEARCH_LIMIT = 100;
const UNSUPPORTED_PROTOCOL_REASON = 'unsupported_protocol';
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;

export type LocalProjectFileTransport = {
  listDir: (args: {
    readonly relativePath: string;
    readonly limit?: number;
  }) => Promise<LocalProjectDirectoryListResult>;
  listFiles: (args?: { readonly maxFiles?: number }) => Promise<LocalProjectFileListResult>;
  /**
   * Host-side search. Resolves `null` when the daemon predates
   * `local-project/search-files`; the caller then filters `listFiles` itself.
   */
  searchFiles: (args: {
    readonly query: string;
    readonly limit?: number;
  }) => Promise<LocalProjectFileSearchResult | null>;
  readFile: (args: {
    readonly relativePath: string;
    readonly maxBytes?: number;
  }) => Promise<LocalProjectFileReadResult | null>;
};

export type LocalProjectRpcFileProviderOptions = {
  readonly transport: LocalProjectFileTransport;
};

/** What the request facade answers instead of sending a request the daemon cannot parse. */
export function unsupportedLocalProjectControlResponse(
  type: LocalProjectControlRequest['type']
): LocalProjectControlResponse {
  return {
    ok: false,
    type,
    error: 'invalid_request',
    message: 'The machine does not support this request yet.',
    data: { reason: UNSUPPORTED_PROTOCOL_REASON },
  };
}

function isUnsupportedLocalProjectControlResponse(
  response: LocalProjectControlResponse | null
): boolean {
  if (!response || response.ok) return false;
  // A local daemon that predates the request rejects it as invalid outright.
  if (response.error === 'invalid_request') return true;
  const data = response.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { reason?: unknown }).reason === UNSUPPORTED_PROTOCOL_REASON
  );
}

/**
 * Sends `request` and returns null for the facade's "daemon too old" answer, so
 * callers can choose their legacy path; every other failure still throws.
 */
export async function requestLocalProjectControlIfSupported<
  TType extends LocalProjectControlRequest['type'],
>(
  requestLocalProjectControl: (
    request: LocalProjectControlRequest,
    options?: { timeoutMs?: number }
  ) => Promise<LocalProjectControlResponse | null>,
  request: Extract<LocalProjectControlRequest, { type: TType }>,
  options?: { timeoutMs?: number }
): Promise<Extract<LocalProjectControlResponse, { ok: true; type: TType }> | null> {
  const response = await requestLocalProjectControl(request, options);
  if (isUnsupportedLocalProjectControlResponse(response)) return null;
  return assertLocalProjectControlResponse(response, request.type as TType);
}

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
  /**
   * The local daemon's machine id. Host-side search goes through the generic
   * control channel, which addresses a machine; without it search reports
   * unsupported and callers filter the full list.
   */
  readonly machineId?: MachineId | null;
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
    searchFiles: async ({ query, limit }) => {
      const localProjects = getIpcServices()?.localProjects;
      if (!localProjects) {
        throw new Error('Local project file IPC is unavailable.');
      }
      const machineId = args.machineId;
      if (!machineId) return null;
      const response = await requestLocalProjectControlIfSupported(
        (request) => localProjects.control(request),
        {
          type: 'local-project/search-files',
          machineId,
          workspaceId: args.workspaceId,
          localProjectId: args.localProjectId,
          query,
          limit,
        }
      );
      return response?.result ?? null;
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
    searchFiles: async ({ query, limit }) => {
      const response = await requestLocalProjectControlIfSupported(
        args.requestLocalProjectControl,
        {
          type: 'local-project/search-files',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          localProjectId: args.localProjectId,
          query,
          limit,
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return response?.result ?? null;
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
    const searched = await this.options.transport.searchFiles({
      query,
      limit: DEFAULT_LOCAL_PROJECT_SEARCH_LIMIT,
    });
    if (searched) return searched.paths.map((path) => toFileEntry(path));

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
