import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  githubCompareCommits,
  githubFetchFileBytesAtCommit,
  githubFetchPullRequestCommits,
  GitHubFileNotFoundError,
  GitHubFileTooLargeError,
  type GitHubPullRequestCommit,
  type GitHubPullRequestFile,
  type GitHubReadRequestOptions,
} from '@lody/shared';
import { useGitHubPrIdentity } from './use-github-pr-identity';
import { withGitHubTokenRetry } from '@/lib/github-token';
import { resolvePrCompareRange, type PrCommitSelection } from '@/lib/github-pr-diff';

export type GitHubPrDiffState = 'idle' | 'loading' | 'ready' | 'error';
export type GitHubPrFileContent =
  | { status: 'loading' }
  | { status: 'ready'; oldText: string; newText: string }
  | { status: 'unavailable'; reason: 'binary' | 'large' | 'missing' | 'error' };

export interface UseGitHubPrDiffResult {
  state: GitHubPrDiffState;
  commits: GitHubPullRequestCommit[];
  files: GitHubPullRequestFile[];
  range: ReturnType<typeof resolvePrCompareRange> | null;
  mergeBaseSha: string | null;
  error: Error | null;
  contentByPath: ReadonlyMap<string, GitHubPrFileContent>;
  refresh: () => Promise<void>;
  loadFile: (file: GitHubPullRequestFile) => Promise<void>;
}

export function useGitHubPrDiff(input: {
  workspaceId?: string | null;
  sessionId?: string;
  repoFullName?: string | null;
  prNumber?: number | null;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
  selection: PrCommitSelection;
  visible?: boolean;
}): UseGitHubPrDiffResult {
  const identity = useGitHubPrIdentity({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    visible: input.visible,
  });
  const enabled = Boolean(
    identity.ready && input.repoFullName && input.prNumber && input.baseRef && input.headSha
  );
  const [state, setState] = useState<GitHubPrDiffState>('idle');
  const [commits, setCommits] = useState<GitHubPullRequestCommit[]>([]);
  const [files, setFiles] = useState<GitHubPullRequestFile[]>([]);
  const [mergeBaseSha, setMergeBaseSha] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [contentByPath, setContentByPath] = useState<Map<string, GitHubPrFileContent>>(new Map());
  const requestKey = JSON.stringify([
    identity.repositoryId,
    identity.repoFullName,
    input.prNumber,
    input.baseRef,
    input.baseSha,
    input.headSha,
    input.selection,
  ]);
  const requestKeyRef = useRef(requestKey);
  const inFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  useLayoutEffect(() => {
    requestKeyRef.current = requestKey;
  }, [requestKey]);

  const range = useMemo(() => {
    if (!input.baseRef || !input.headSha) return null;
    return resolvePrCompareRange({
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      headSha: input.headSha,
      commits,
      selection: input.selection,
    });
  }, [commits, input.baseRef, input.baseSha, input.headSha, input.selection]);

  const refresh = useCallback(async () => {
    if (!enabled || !identity.repositoryId || !identity.repoFullName || !input.prNumber) return;
    const targetKey = requestKey;
    const existing = inFlightRef.current.get(targetKey);
    if (existing) return existing;
    const run = (async () => {
      setState('loading');
      setError(null);
      setFiles([]);
      setMergeBaseSha(null);
      setContentByPath(new Map());
      try {
        const options: GitHubReadRequestOptions = { cache: 'reload' };
        const nextCommits = await withGitHubTokenRetry(
          input.workspaceId!,
          identity.repoFullName!,
          (token) =>
            githubFetchPullRequestCommits(token, identity.repoFullName!, input.prNumber!, options),
          identity.repositoryId
        );
        if (requestKeyRef.current !== targetKey) return;
        setCommits(nextCommits);
        const nextRange = resolvePrCompareRange({
          baseRef: input.baseRef!,
          baseSha: input.baseSha,
          headSha: input.headSha!,
          commits: nextCommits,
          selection: input.selection,
        });
        const comparison = await withGitHubTokenRetry(
          input.workspaceId!,
          identity.repoFullName!,
          (token) =>
            githubCompareCommits(
              token,
              identity.repoFullName!,
              nextRange.from,
              nextRange.to,
              options
            ),
          identity.repositoryId
        );
        if (requestKeyRef.current !== targetKey) return;
        setMergeBaseSha(comparison.mergeBaseSha);
        setFiles(comparison.files);
        setContentByPath(new Map());
        setState('ready');
      } catch (caught) {
        if (requestKeyRef.current !== targetKey) return;
        setState('error');
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        inFlightRef.current.delete(targetKey);
      }
    })();
    inFlightRef.current.set(targetKey, run);
    return run;
  }, [
    enabled,
    identity.repoFullName,
    identity.repositoryId,
    input.baseRef,
    input.baseSha,
    input.headSha,
    input.prNumber,
    input.selection,
    input.workspaceId,
    requestKey,
  ]);

  useEffect(() => {
    if (!enabled || input.visible === false) return;
    void refresh();
  }, [enabled, input.visible, refresh]);

  const loadFile = useCallback(
    async (file: GitHubPullRequestFile) => {
      if (
        !enabled ||
        !range ||
        !identity.repositoryId ||
        !identity.repoFullName ||
        !input.workspaceId
      ) {
        return;
      }
      const path = file.path;
      const targetKey = requestKey;
      const previous = contentByPath.get(path);
      if (
        previous?.status === 'loading' ||
        previous?.status === 'ready' ||
        previous?.status === 'unavailable'
      ) {
        return;
      }
      setContentByPath((current) => new Map(current).set(path, { status: 'loading' }));
      try {
        const read = (token: string, ref: string, readPath: string) =>
          githubFetchFileBytesAtCommit(token, identity.repoFullName!, readPath, ref);
        const decode = (bytes: Uint8Array): string => {
          if (bytes.includes(0)) throw new Error('binary');
          try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            throw new Error('binary');
          }
        };
        const result = await withGitHubTokenRetry(
          input.workspaceId,
          identity.repoFullName,
          async (token) => {
            const [oldBytes, newBytes] = await Promise.all([
              file.status === 'added'
                ? Promise.resolve(new Uint8Array())
                : read(token, mergeBaseSha ?? range.from, file.previousPath ?? path),
              file.status === 'removed'
                ? Promise.resolve(new Uint8Array())
                : read(token, range.to, path),
            ]);
            return { oldText: decode(oldBytes), newText: decode(newBytes) };
          },
          identity.repositoryId
        );
        if (requestKeyRef.current !== targetKey) return;
        setContentByPath((current) => new Map(current).set(path, { status: 'ready', ...result }));
      } catch (caught) {
        if (requestKeyRef.current !== targetKey) return;
        const reason =
          caught instanceof GitHubFileTooLargeError
            ? 'large'
            : caught instanceof GitHubFileNotFoundError
              ? 'missing'
              : caught instanceof Error && caught.message === 'binary'
                ? 'binary'
                : 'error';
        setContentByPath((current) =>
          new Map(current).set(path, { status: 'unavailable', reason })
        );
      }
    },
    [
      contentByPath,
      enabled,
      identity.repoFullName,
      identity.repositoryId,
      input.workspaceId,
      mergeBaseSha,
      requestKey,
      range,
    ]
  );

  return {
    state: enabled ? state : 'idle',
    commits,
    files,
    range,
    mergeBaseSha,
    error: identity.error ?? error,
    contentByPath,
    refresh,
    loadFile,
  };
}
