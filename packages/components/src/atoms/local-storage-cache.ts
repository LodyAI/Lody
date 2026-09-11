import { atom } from 'jotai';
import type { PersistedMentionRange } from '@/components/mentions/mention-persistence';
import { atomFamily, atomWithStorage } from 'jotai/utils';
import type { PastedTextDraft } from '@/lib/pasted-text-draft';
import {
  type CachedGitHubRepo,
  type WorkspaceReposCache,
  githubReposCache,
} from '@/lib/local-storage-cache';

// ============ GitHub Repos Cache ============

export const allGitHubReposCacheAtom = atom<Record<string, WorkspaceReposCache>>(
  githubReposCache.readAll()
);

export const workspaceReposCacheAtomFamily = atomFamily((workspaceId: string | null) =>
  atom((get): CachedGitHubRepo[] | null => {
    if (!workspaceId) return null;
    return get(allGitHubReposCacheAtom)[workspaceId]?.repositories ?? null;
  })
);

export const setWorkspaceReposCacheAtom = atom(
  null,
  (
    get,
    set,
    { workspaceId, repositories }: { workspaceId: string; repositories: CachedGitHubRepo[] }
  ) => {
    const cache: WorkspaceReposCache = { repositories, updatedAt: Date.now() };
    githubReposCache.set(workspaceId, cache);
    set(allGitHubReposCacheAtom, { ...get(allGitHubReposCacheAtom), [workspaceId]: cache });
  }
);

// ============ Chat Landing State (persisted to localStorage, scoped by user/window surface) ============

export interface ChatLandingSessionState {
  prompt: string;
  pastedTextDrafts?: PastedTextDraft[];
  /**
   * Mention ranges for `prompt`. Stored so a returning draft shows its mentions
   * without waiting for the file index, the slug cache or the issue list to
   * load — and without depending on them ever loading.
   */
  mentionRanges?: PersistedMentionRange[];
}

const CHAT_LANDING_STATE_KEY_PREFIX = 'lody:chatLandingState';
const DEFAULT_CHAT_LANDING_STATE: ChatLandingSessionState = {
  prompt: '',
  pastedTextDrafts: [],
  mentionRanges: [],
};

/**
 * Chat landing state atom family. Normal chat uses the userId key; alternate
 * surfaces may append a suffix so they do not clobber the user's main draft.
 */
export const chatLandingSessionStateAtomFamily = atomFamily((stateKey: string | null) =>
  atomWithStorage<ChatLandingSessionState>(
    stateKey ? `${CHAT_LANDING_STATE_KEY_PREFIX}:${stateKey}` : CHAT_LANDING_STATE_KEY_PREFIX,
    DEFAULT_CHAT_LANDING_STATE
  )
);
