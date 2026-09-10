import type { PagedFileSource } from './paged-file-source';
import type {
  CodeCollabContentUnavailableReason,
  CodeCollabFileKind,
  CodeCollabFileSourceState,
  CodeCollabProviderKind,
  CodeCollabSpecialKind,
  CodeCollabTextEol,
} from '@lody/shared';

export type FileWorkspaceProviderEntry = {
  readonly entryType?: 'file' | 'lazy-directory';
  readonly fileId?: string;
  readonly directoryId?: string;
  readonly path: string;
  readonly kind: CodeCollabFileKind;
  readonly sourceState: CodeCollabFileSourceState;
  readonly sizeBytes?: number;
  readonly mode?: number;
  readonly executable?: boolean;
  readonly textEol?: CodeCollabTextEol;
  readonly hasBom?: boolean;
  readonly modifiedTime?: number;
  readonly liveTextMaterialized?: boolean;
  readonly readonly?: boolean;
  readonly linkTarget?: string;
  readonly specialKind?: CodeCollabSpecialKind;
  readonly unavailableReason?: CodeCollabContentUnavailableReason;
  readonly updatedAt?: string;
};

export type FileWorkspaceTextSnapshot = {
  readonly kind: 'text';
  readonly text: string;
  readonly eol?: 'lf' | 'crlf' | 'mixed' | 'unknown';
};

export type FileWorkspaceBinarySnapshot = {
  readonly kind: 'binary';
  readonly bytes?: Uint8Array;
  readonly mimeType?: string;
  readonly url?: string;
};

export type FileWorkspaceUnavailableSnapshot = {
  readonly kind: 'unavailable';
  readonly reason: CodeCollabContentUnavailableReason;
  readonly message?: string;
};

export type FileWorkspaceSnapshot =
  | { readonly kind: 'paged-text'; readonly source: PagedFileSource }
  | FileWorkspaceTextSnapshot
  | FileWorkspaceBinarySnapshot
  | FileWorkspaceUnavailableSnapshot;

export type FileWorkspaceOpenResult =
  | {
      readonly status: 'ready';
      readonly entry: FileWorkspaceProviderEntry;
      readonly snapshot: FileWorkspaceSnapshot;
    }
  | {
      readonly status: 'unavailable';
      readonly entry?: FileWorkspaceProviderEntry;
      readonly reason: CodeCollabContentUnavailableReason;
      readonly message?: string;
    };

export type FileWorkspaceProviderState = {
  readonly kind: CodeCollabProviderKind;
  readonly ready: boolean;
  readonly sourceState: CodeCollabFileSourceState;
  readonly message?: string;
};

export type FileWorkspaceHostLivenessSnapshot = {
  readonly status: 'online' | 'expired';
  readonly ageMs?: number;
};

export interface FileWorkspaceProvider {
  readonly kind: CodeCollabProviderKind;
  getState(): FileWorkspaceProviderState;
  listFiles(): Promise<readonly FileWorkspaceProviderEntry[]>;
  subscribeFiles?(callback: (files: readonly FileWorkspaceProviderEntry[]) => void): () => void;
  initializeDirectory?(directoryId: string): Promise<void>;
  searchFiles(query: string): Promise<readonly FileWorkspaceProviderEntry[]>;
  getFile(pathOrFileId: string): Promise<FileWorkspaceProviderEntry | null>;
  openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult>;
  saveText(pathOrFileId: string, text: string): Promise<FileWorkspaceOpenResult>;
  updateLiveText?(pathOrFileId: string, text: string): Promise<void>;
  subscribeText?(pathOrFileId: string, callback: (text: string) => void): () => void;
  getHostLivenessStatus?(): Promise<FileWorkspaceHostLivenessSnapshot>;
  subscribeHostLiveness?(
    callback: (snapshot: FileWorkspaceHostLivenessSnapshot) => void
  ): () => void;
  resolveSaveConflict?(
    pathOrFileId: string,
    params: {
      readonly conflictId: string;
      readonly resolution: 'override' | 'discard' | 'load_with_conflicts';
    }
  ): Promise<void>;
}

export interface FileWorkspaceLspProvider {
  requestLspDefinition(
    pathOrFileId: string,
    position: { readonly line: number; readonly character: number }
  ): Promise<unknown>;
  requestLspReferences(
    pathOrFileId: string,
    position: { readonly line: number; readonly character: number },
    options?: { readonly includeDeclaration?: boolean }
  ): Promise<unknown>;
}

export function hasFileWorkspaceLspProvider(
  provider: FileWorkspaceProvider | null | undefined
): provider is FileWorkspaceProvider & FileWorkspaceLspProvider {
  const candidate = provider as Partial<FileWorkspaceLspProvider> | null | undefined;
  return (
    typeof candidate?.requestLspDefinition === 'function' &&
    typeof candidate.requestLspReferences === 'function'
  );
}

export type FakeFileWorkspaceProviderOptions = {
  readonly kind?: CodeCollabProviderKind;
  readonly sourceState?: CodeCollabFileSourceState;
  readonly files?: readonly FileWorkspaceProviderEntry[];
  readonly snapshots?:
    | ReadonlyMap<string, FileWorkspaceSnapshot>
    | Record<string, FileWorkspaceSnapshot>;
  readonly hostLiveness?: FileWorkspaceHostLivenessSnapshot;
};

export function createFakeFileWorkspaceProvider(
  options: FakeFileWorkspaceProviderOptions = {}
): FileWorkspaceProvider {
  return new FakeFileWorkspaceProvider(options);
}

class FakeFileWorkspaceProvider implements FileWorkspaceProvider {
  readonly kind: CodeCollabProviderKind;
  private readonly sourceState: CodeCollabFileSourceState;
  private readonly files: FileWorkspaceProviderEntry[];
  private readonly snapshots: Map<string, FileWorkspaceSnapshot>;
  private readonly hostLiveness: FileWorkspaceHostLivenessSnapshot;

  constructor(options: FakeFileWorkspaceProviderOptions) {
    this.kind = options.kind ?? 'code-collab';
    this.sourceState = options.sourceState ?? 'live-collaborative';
    this.files = [...(options.files ?? [])].toSorted((left, right) =>
      left.path.localeCompare(right.path)
    );
    this.snapshots = toSnapshotMap(options.snapshots);
    this.hostLiveness = options.hostLiveness ?? { status: 'online' };
  }

  getState(): FileWorkspaceProviderState {
    return {
      kind: this.kind,
      ready: true,
      sourceState: this.sourceState,
    };
  }

  async listFiles(): Promise<readonly FileWorkspaceProviderEntry[]> {
    return this.files;
  }

  async searchFiles(query: string): Promise<readonly FileWorkspaceProviderEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return this.files;
    return this.files.filter(
      (file) =>
        file.path.toLowerCase().includes(normalized) ||
        file.fileId?.toLowerCase().includes(normalized)
    );
  }

  async getFile(pathOrFileId: string): Promise<FileWorkspaceProviderEntry | null> {
    return this.findFile(pathOrFileId);
  }

  async openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult> {
    const entry = this.findFile(pathOrFileId);
    if (!entry) {
      return {
        status: 'unavailable',
        reason: 'metadata-only',
        message: 'File is not indexed by this provider',
      };
    }
    if (entry.unavailableReason) {
      return {
        status: 'unavailable',
        entry,
        reason: entry.unavailableReason,
      };
    }
    const snapshot = this.snapshots.get(entry.path) ?? this.snapshots.get(entry.fileId ?? '');
    return {
      status: 'ready',
      entry,
      snapshot: snapshot ?? { kind: 'unavailable', reason: 'metadata-only' },
    };
  }

  async saveText(pathOrFileId: string, text: string): Promise<FileWorkspaceOpenResult> {
    const entry = this.findFile(pathOrFileId);
    if (!entry) {
      return {
        status: 'unavailable',
        reason: 'metadata-only',
        message: 'File is not indexed by this provider',
      };
    }
    if (entry.readonly) {
      return {
        status: 'unavailable',
        entry,
        reason: 'permission-denied',
      };
    }
    this.snapshots.set(entry.path, { kind: 'text', text });
    return {
      status: 'ready',
      entry,
      snapshot: { kind: 'text', text },
    };
  }

  async getHostLivenessStatus(): Promise<FileWorkspaceHostLivenessSnapshot> {
    return this.hostLiveness;
  }

  subscribeHostLiveness(
    callback: (snapshot: FileWorkspaceHostLivenessSnapshot) => void
  ): () => void {
    callback(this.hostLiveness);
    return () => undefined;
  }

  private findFile(pathOrFileId: string): FileWorkspaceProviderEntry | null {
    return (
      this.files.find((file) => file.path === pathOrFileId || file.fileId === pathOrFileId) ?? null
    );
  }
}

function toSnapshotMap(
  input: FakeFileWorkspaceProviderOptions['snapshots']
): Map<string, FileWorkspaceSnapshot> {
  if (!input) return new Map();
  return input instanceof Map
    ? new Map<string, FileWorkspaceSnapshot>(input)
    : new Map<string, FileWorkspaceSnapshot>(Object.entries(input));
}
