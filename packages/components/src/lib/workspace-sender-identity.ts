import { z } from 'zod';
import type { WorkspaceDirectoryMember } from '@lody/cloud-api';
import { createLocalStorageCache } from './local-storage-cache';

export const WORKSPACE_MEMBERS_DIRECTORY_CACHE_KEY = 'lody:workspaceMembersDirectory';
export const WORKSPACE_SENDER_PROFILES_CACHE_KEY = 'lody:workspaceSenderProfiles';

const MAX_CACHED_PROFILES_PER_SCOPE = 128;

export type CachedSenderProfile = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  image?: string | null;
} | null;

const directoryMemberSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});

const directoryEntrySchema = z.object({
  rows: z.array(directoryMemberSchema),
  updatedAt: z.number(),
});

const senderProfileSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    image: z.string().nullable().optional(),
  })
  .nullable();

const senderProfileScopeSchema = z.object({
  profiles: z.record(z.string(), senderProfileSchema),
  updatedAt: z.number(),
});

const persistentDirectoryCache = createLocalStorageCache(
  WORKSPACE_MEMBERS_DIRECTORY_CACHE_KEY,
  directoryEntrySchema
);

const persistentSenderProfilesCache = createLocalStorageCache(
  WORKSPACE_SENDER_PROFILES_CACHE_KEY,
  senderProfileScopeSchema
);

const persistentCloudApis = new WeakSet<object>();
const fallbackApiKey = {};
const directoryByApi = new WeakMap<object, Map<string, WorkspaceDirectoryMember[]>>();
const directoryListenersByApi = new WeakMap<object, Map<string, Set<() => void>>>();
const senderProfilesByApi = new WeakMap<object, Map<string, CachedSenderProfile>>();
const senderProfileListenersByApi = new WeakMap<object, Map<string, Set<() => void>>>();

export function markPersistentWorkspaceSenderCloudApi(api: object): void {
  persistentCloudApis.add(api);
}

export function isPersistentWorkspaceSenderCloudApi(api: object | null | undefined): boolean {
  return typeof api === 'object' && api !== null && persistentCloudApis.has(api);
}

export function buildWorkspaceSenderScopeKey(
  accountId: string | null | undefined,
  workspaceId: string | null | undefined
): string | null {
  const normalizedAccount = accountId?.trim();
  const normalizedWorkspace = workspaceId?.trim();
  if (!normalizedAccount || !normalizedWorkspace) {
    return null;
  }
  return JSON.stringify([normalizedAccount, normalizedWorkspace]);
}

export function resolveSenderDisplayName(
  user?: {
    name?: string | null;
    email?: string | null;
  } | null
): string | null {
  return user?.name?.trim() || user?.email?.trim() || null;
}

function getApiOwner(api: object | null | undefined): object {
  return typeof api === 'object' && api !== null ? api : fallbackApiKey;
}

function getDirectoryMap(api: object | null | undefined): Map<string, WorkspaceDirectoryMember[]> {
  const owner = getApiOwner(api);
  let map = directoryByApi.get(owner);
  if (!map) {
    map = new Map();
    directoryByApi.set(owner, map);
  }
  return map;
}

function getSenderProfilesMap(api: object | null | undefined): Map<string, CachedSenderProfile> {
  const owner = getApiOwner(api);
  let map = senderProfilesByApi.get(owner);
  if (!map) {
    map = new Map();
    senderProfilesByApi.set(owner, map);
  }
  return map;
}

function notifyScopedListeners(
  store: WeakMap<object, Map<string, Set<() => void>>>,
  api: object | null | undefined,
  key: string
): void {
  const listeners = store.get(getApiOwner(api))?.get(key);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

function subscribeScopedListeners(
  store: WeakMap<object, Map<string, Set<() => void>>>,
  api: object | null | undefined,
  key: string | null,
  listener: () => void
): () => void {
  if (!key) return () => {};
  const owner = getApiOwner(api);
  let byKey = store.get(owner);
  if (!byKey) {
    byKey = new Map();
    store.set(owner, byKey);
  }
  let listeners = byKey.get(key);
  if (!listeners) {
    listeners = new Set();
    byKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      byKey.delete(key);
    }
  };
}

function areDirectoryRowsEqual(
  previous: readonly WorkspaceDirectoryMember[] | undefined,
  next: readonly WorkspaceDirectoryMember[]
): boolean {
  if (!previous || previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b || a.userId !== b.userId || a.name !== b.name || a.image !== b.image) {
      return false;
    }
  }
  return true;
}

function areSenderProfilesEqual(
  previous: CachedSenderProfile | undefined,
  next: CachedSenderProfile
): boolean {
  if (previous === undefined) return false;
  if (previous === null || next === null) return previous === next;
  return (
    (previous.id ?? null) === (next.id ?? null) &&
    (previous.name ?? null) === (next.name ?? null) &&
    (previous.email ?? null) === (next.email ?? null) &&
    (previous.image ?? null) === (next.image ?? null)
  );
}

export function readRetainedWorkspaceMembers(
  api: object | null | undefined,
  scopeKey: string | null
): WorkspaceDirectoryMember[] | undefined {
  if (!scopeKey) return undefined;
  const memory = getDirectoryMap(api);
  const existing = memory.get(scopeKey);
  if (existing !== undefined) return existing;
  if (!isPersistentWorkspaceSenderCloudApi(api)) return undefined;
  const persisted = persistentDirectoryCache.get(scopeKey)?.rows;
  if (persisted !== undefined) {
    memory.set(scopeKey, persisted);
  }
  return persisted;
}

export function writeRetainedWorkspaceMembers(
  api: object | null | undefined,
  scopeKey: string | null,
  rows: readonly WorkspaceDirectoryMember[]
): void {
  if (!scopeKey) return;
  const memory = getDirectoryMap(api);
  const normalized = rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    image: row.image,
  }));
  const existing = memory.get(scopeKey);
  const changed = !areDirectoryRowsEqual(existing, normalized);
  memory.set(scopeKey, normalized);
  if (isPersistentWorkspaceSenderCloudApi(api) && changed) {
    persistentDirectoryCache.set(scopeKey, {
      rows: normalized,
      updatedAt: Date.now(),
    });
  }
  if (changed) {
    notifyScopedListeners(directoryListenersByApi, api, scopeKey);
  }
}

export function subscribeRetainedWorkspaceMembers(
  api: object | null | undefined,
  scopeKey: string | null,
  listener: () => void
): () => void {
  return subscribeScopedListeners(directoryListenersByApi, api, scopeKey, listener);
}

export function readRetainedWorkspaceMemberUser(
  api: object | null | undefined,
  scopeKey: string | null,
  userId: string | null | undefined
): WorkspaceDirectoryMember | undefined {
  if (!scopeKey || !userId) return undefined;
  return readRetainedWorkspaceMembers(api, scopeKey)?.find((row) => row.userId === userId);
}

function buildSenderProfileKey(scopeKey: string, userId: string): string {
  return `${scopeKey}:${userId}`;
}

export function readRetainedSenderProfile(
  api: object | null | undefined,
  scopeKey: string | null,
  userId: string | null | undefined
): CachedSenderProfile | undefined {
  if (!scopeKey || !userId) return undefined;
  const profileKey = buildSenderProfileKey(scopeKey, userId);
  const memory = getSenderProfilesMap(api);
  if (memory.has(profileKey)) {
    return memory.get(profileKey);
  }
  if (!isPersistentWorkspaceSenderCloudApi(api)) {
    return undefined;
  }
  const persistedScope = persistentSenderProfilesCache.get(scopeKey);
  if (!persistedScope || !(userId in persistedScope.profiles)) {
    return undefined;
  }
  const profile = persistedScope.profiles[userId] ?? null;
  memory.set(profileKey, profile);
  return profile;
}

export function writeRetainedSenderProfile(
  api: object | null | undefined,
  scopeKey: string | null,
  userId: string | null | undefined,
  profile: CachedSenderProfile
): void {
  if (!scopeKey || !userId) return;
  const profileKey = buildSenderProfileKey(scopeKey, userId);
  const memory = getSenderProfilesMap(api);
  const normalized: CachedSenderProfile =
    profile === null
      ? null
      : {
          id: profile.id ?? userId,
          name: profile.name ?? undefined,
          email: profile.email ?? undefined,
          image: profile.image ?? null,
        };
  const existing = memory.has(profileKey) ? memory.get(profileKey) : undefined;
  const changed = !areSenderProfilesEqual(existing, normalized);
  memory.set(profileKey, normalized);
  if (isPersistentWorkspaceSenderCloudApi(api) && changed) {
    const current = persistentSenderProfilesCache.get(scopeKey)?.profiles ?? {};
    const nextProfiles: Record<string, CachedSenderProfile> = { ...current };
    delete nextProfiles[userId];
    nextProfiles[userId] = normalized;
    const keys = Object.keys(nextProfiles);
    while (keys.length > MAX_CACHED_PROFILES_PER_SCOPE) {
      const oldest = keys.shift();
      if (oldest) delete nextProfiles[oldest];
    }
    persistentSenderProfilesCache.set(scopeKey, {
      profiles: nextProfiles,
      updatedAt: Date.now(),
    });
  }
  if (changed) {
    notifyScopedListeners(senderProfileListenersByApi, api, profileKey);
  }
}

export function subscribeRetainedSenderProfile(
  api: object | null | undefined,
  scopeKey: string | null,
  userId: string | null | undefined,
  listener: () => void
): () => void {
  if (!scopeKey || !userId) return () => {};
  return subscribeScopedListeners(
    senderProfileListenersByApi,
    api,
    buildSenderProfileKey(scopeKey, userId),
    listener
  );
}
