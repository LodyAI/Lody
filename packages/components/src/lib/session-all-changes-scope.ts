import type { CodeCollabAllChangesScope, SessionMeta } from '@lody/shared';
import { isWorktreeSessionMeta } from '@lody/shared';
import { resolveWorkspaceOwnerSession } from './session-github-state';

export type AllChangesScopePolicy = {
  readonly ownerSession: SessionMeta | null;
  readonly tracksUncommittedOnly: boolean;
  readonly canToggleScope: boolean;
  readonly requestScope: CodeCollabAllChangesScope;
};

export type AllChangesBasePresentation =
  | { readonly kind: 'loading' }
  | { readonly kind: 'session-changes' }
  | { readonly kind: 'head'; readonly ref: string }
  | { readonly kind: 'branch'; readonly branchName: string | null; readonly ref: string };

export type AllChangesEmptyReason =
  | 'no-uncommitted-changes'
  | 'focus-no-uncommitted-changes'
  | 'focus-no-branch-changes'
  | 'no-changes';

export type AllChangesFocusOutsideScopeReason =
  | 'focus-no-uncommitted-changes'
  | 'focus-no-branch-changes'
  | null;

export type ResolvedAllChangesUiState = {
  readonly tracksUncommittedOnly: boolean;
  readonly canToggleScope: boolean;
  readonly requestScope: CodeCollabAllChangesScope;
  readonly base: AllChangesBasePresentation;
  readonly emptyReason: AllChangesEmptyReason;
  readonly focusOutsideScopeReason: AllChangesFocusOutsideScopeReason;
};

export function resolveAllChangesScopePolicy(input: {
  readonly session?: SessionMeta | null;
  readonly workspaceSession?: SessionMeta | null;
  readonly preferredScope: CodeCollabAllChangesScope;
  readonly scopeSupported: boolean;
}): AllChangesScopePolicy {
  const ownerSession = resolveWorkspaceOwnerSession(input.session, input.workspaceSession);
  const tracksUncommittedOnly = ownerSession !== null && !isWorktreeSessionMeta(ownerSession);
  const canToggleScope = input.scopeSupported && !tracksUncommittedOnly;
  const requestScope: CodeCollabAllChangesScope = canToggleScope ? input.preferredScope : 'branch';
  return { ownerSession, tracksUncommittedOnly, canToggleScope, requestScope };
}

export function resolveAllChangesUiState(input: {
  readonly session?: SessionMeta | null;
  readonly workspaceSession?: SessionMeta | null;
  readonly preferredScope: CodeCollabAllChangesScope;
  readonly scopeSupported: boolean;
  readonly allChangesBase: string | null;
  readonly focusFilePath?: string | null;
}): ResolvedAllChangesUiState {
  const { ownerSession, tracksUncommittedOnly, canToggleScope, requestScope } =
    resolveAllChangesScopePolicy(input);
  const allChangesBase = input.allChangesBase;
  const isUncommittedPresentation =
    requestScope === 'uncommitted' ||
    (tracksUncommittedOnly && allChangesBase !== null && allChangesBase !== 'diff-store');

  const formattedRef =
    allChangesBase === null
      ? '…'
      : /^[0-9a-f]{12,}$/i.test(allChangesBase)
        ? allChangesBase.slice(0, 7)
        : allChangesBase;

  let base: AllChangesBasePresentation;
  if (allChangesBase === 'diff-store') {
    base = { kind: 'session-changes' };
  } else if (tracksUncommittedOnly && allChangesBase === null) {
    base = { kind: 'loading' };
  } else if (isUncommittedPresentation) {
    base = { kind: 'head', ref: formattedRef };
  } else {
    base = {
      kind: 'branch',
      branchName: ownerSession?.baseBranch?.trim() || input.session?.baseBranch?.trim() || null,
      ref: formattedRef,
    };
  }

  const hasFocus = Boolean(input.focusFilePath);
  const emptyReason: AllChangesEmptyReason = isUncommittedPresentation
    ? hasFocus
      ? 'focus-no-uncommitted-changes'
      : 'no-uncommitted-changes'
    : !tracksUncommittedOnly && hasFocus
      ? 'focus-no-branch-changes'
      : 'no-changes';

  const focusOutsideScopeReason: AllChangesFocusOutsideScopeReason = isUncommittedPresentation
    ? 'focus-no-uncommitted-changes'
    : tracksUncommittedOnly
      ? null
      : 'focus-no-branch-changes';

  return {
    tracksUncommittedOnly,
    canToggleScope,
    requestScope,
    base,
    emptyReason,
    focusOutsideScopeReason,
  };
}
