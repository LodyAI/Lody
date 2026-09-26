import {
  GitHubFileTooLargeError,
  githubFetchDefaultBranch,
  githubFetchFileAtCommit,
  githubFetchFileBytesAtCommit,
  githubFetchTreeLevel,
  isBinaryImagePath,
  SESSION_IMAGE_MAX_SIZE_BYTES,
  type GitHubTreeLevelEntry,
} from '@lody/shared';
import { withGitHubTokenRetry } from './github-token';
import { fetchRepoFilePaths, type RepoFilePathsCacheEntry } from './repo-file-paths-cache';
import {
  LazyDirectoryFileProvider,
  joinProjectPath,
  toDirectoryEntry,
  toFileEntry,
} from './lazy-directory-file-provider';
import type {
  FileWorkspaceOpenResult,
  FileWorkspaceProviderEntry,
} from './file-workspace-provider';

const DEFAULT_SEARCH_MAX_FILES = 80_000;
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;

export type GitHubRepoFileProviderOptions = {
  readonly workspaceId: string;
  readonly repoFullName: string;
  readonly branch?: string;
};

export class GitHubRepoFileProvider extends LazyDirectoryFileProvider {
  private readonly directoryTreeShaByPath = new Map<string, string>();
  private resolvedBranch: string | undefined;
  private searchPaths: Promise<RepoFilePathsCacheEntry> | null = null;

  constructor(private readonly options: GitHubRepoFileProviderOptions) {
    super();
  }

  async searchFiles(query: string): Promise<readonly FileWorkspaceProviderEntry[]> {
    const result = await this.loadSearchPaths();
    const normalized = query.trim().toLowerCase();
    const paths = normalized
      ? result.paths.filter((path) => path.toLowerCase().includes(normalized))
      : result.paths;
    return paths.slice(0, DEFAULT_SEARCH_MAX_FILES).map((path) => toFileEntry(path));
  }

  /**
   * Fetched fresh once per provider, like the directory listing it sits next
   * to, then reused: search runs per keystroke and the recursive tree is
   * megabytes of JSON. The shared cache's TTL would hide files pushed since.
   */
  private loadSearchPaths(): Promise<RepoFilePathsCacheEntry> {
    this.searchPaths ??= this.getBranch()
      .then((branch) =>
        fetchRepoFilePaths(this.options.workspaceId, this.options.repoFullName, branch)
      )
      .catch((error: unknown) => {
        this.searchPaths = null;
        throw error;
      });
    return this.searchPaths;
  }

  async openFile(pathOrFileId: string): Promise<FileWorkspaceOpenResult> {
    const branch = await this.getBranch();
    const entry = this.entries.get(pathOrFileId) ?? toFileEntry(pathOrFileId);

    // Images (except SVG, which is XML text) are fetched as raw bytes so they
    // can be previewed; everything else is read as text. SVG falls through to
    // the text path and is rendered from its source.
    if (isBinaryImagePath(pathOrFileId)) {
      try {
        const bytes = await withGitHubTokenRetry(
          this.options.workspaceId,
          this.options.repoFullName,
          (token) =>
            githubFetchFileBytesAtCommit(token, this.options.repoFullName, pathOrFileId, branch, {
              maxBytes: SESSION_IMAGE_MAX_SIZE_BYTES,
            })
        );
        this.entries.set(pathOrFileId, entry);
        return { status: 'ready', entry, snapshot: { kind: 'binary', bytes } };
      } catch (error) {
        if (error instanceof GitHubFileTooLargeError) {
          // Omit bytes so the UI shows a "too large to preview" notice instead
          // of a broken image.
          return { status: 'ready', entry, snapshot: { kind: 'binary' } };
        }
        throw error;
      }
    }

    let text: string;
    try {
      text = await withGitHubTokenRetry(
        this.options.workspaceId,
        this.options.repoFullName,
        (token) =>
          githubFetchFileAtCommit(token, this.options.repoFullName, pathOrFileId, branch, {
            maxBytes: DEFAULT_READ_MAX_BYTES,
          })
      );
    } catch (error) {
      if (error instanceof GitHubFileTooLargeError) {
        return {
          status: 'unavailable',
          entry,
          reason: 'text-too-large',
          message: `File is larger than ${DEFAULT_READ_MAX_BYTES} bytes.`,
        };
      }
      throw error;
    }
    this.entries.set(pathOrFileId, entry);
    return {
      status: 'ready',
      entry,
      snapshot: {
        kind: 'text',
        text,
      },
    };
  }

  private async getBranch(): Promise<string> {
    if (this.resolvedBranch) {
      return this.resolvedBranch;
    }
    const explicitBranch = this.options.branch?.trim();
    if (explicitBranch) {
      this.resolvedBranch = explicitBranch;
      return explicitBranch;
    }
    this.resolvedBranch = await withGitHubTokenRetry(
      this.options.workspaceId,
      this.options.repoFullName,
      (token) => githubFetchDefaultBranch(token, this.options.repoFullName)
    );
    return this.resolvedBranch;
  }

  protected async loadDirectoryEntries(
    relativePath: string
  ): Promise<readonly FileWorkspaceProviderEntry[]> {
    const treeRef = relativePath
      ? this.directoryTreeShaByPath.get(relativePath)
      : await this.getBranch();
    if (!treeRef) {
      throw new Error(`Directory is not indexed: ${relativePath}`);
    }

    const result = await withGitHubTokenRetry(
      this.options.workspaceId,
      this.options.repoFullName,
      (token) => githubFetchTreeLevel(token, this.options.repoFullName, treeRef)
    );
    return result.entries.map((child) => this.toTreeEntry(relativePath, child));
  }

  private toTreeEntry(parentPath: string, child: GitHubTreeLevelEntry): FileWorkspaceProviderEntry {
    const path = joinProjectPath(parentPath, child.path);
    if (child.type === 'tree') {
      this.directoryTreeShaByPath.set(path, child.sha);
      return toDirectoryEntry(path);
    }
    return toFileEntry(path, child.size);
  }
}
