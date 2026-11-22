import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  KNOWN_SKILL_DIRS_VERSION,
  compareProjectSkillScope,
  getRegisteredGlobalSkillDirs,
  getRegisteredSkillDirs,
  getRegisteredSystemSkillDirs,
  getServerNow,
  getSkillScanCandidateDirs,
  githubFetchDefaultBranchHead,
  githubFetchProjectSkillsAtCommit,
  type AgentConfigMeta,
  type LocalProjectId,
  type MachineId,
  type ProjectSkillGroup,
  type WorkspaceId,
} from '@lody/shared';
import { getAllAgentConfigAtom, runtimeAtom, userAtom } from '@/atoms';
import { createLocalProjectSkillsTransport } from '@/lib/local-project-skills-provider';
import {
  getGitHubProjectSkillsCacheKey,
  getLocalProjectSkillsCacheKey,
  getMachineGlobalSkillsCacheKey,
  readProjectSkillsCacheEntry,
  writeProjectSkillsCacheEntry,
  type ProjectSkillsCacheEntry,
} from '@/lib/project-skills-cache';
import { withGitHubTokenRetry } from '@/lib/github-token';

export type ProjectSkillsSource =
  | {
      kind: 'local';
      workspaceId: string;
      machineId: string;
      localProjectId: string;
    }
  | {
      kind: 'github';
      workspaceId: string;
      repoFullName: string;
    }
  | {
      // Machine-global skills only (no project/repo) — for GitHub or plain-agent
      // chats that still run on a known machine.
      kind: 'global';
      workspaceId: string;
      machineId: string;
    };

export type ProjectSkillGroupRegistration = 'registered' | 'found';

export type ProjectSkillResolvedGroup = ProjectSkillGroup & {
  registration: ProjectSkillGroupRegistration;
};

export type ProjectSkillsStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';

export type ProjectSkillsState = {
  status: ProjectSkillsStatus;
  groups: ProjectSkillResolvedGroup[];
  rawGroups: ProjectSkillGroup[];
  error?: string;
  stale: boolean;
  fetchedAt?: number;
  refresh: () => void;
};

type NormalizedProjectSkillsSource =
  | {
      kind: 'local';
      workspaceId: string;
      machineId: string;
      localProjectId: string;
    }
  | {
      kind: 'github';
      workspaceId: string;
      repoFullName: string;
    }
  | {
      kind: 'global';
      workspaceId: string;
      machineId: string;
    };

type ProjectSkillsInternalState = Omit<ProjectSkillsState, 'groups' | 'refresh'>;

type RegisteredSkillDirsByScope = {
  project: Set<string>;
  global: Set<string>;
  system: Set<string>;
};

const EMPTY_INTERNAL_STATE: ProjectSkillsInternalState = {
  status: 'idle',
  rawGroups: [],
  stale: false,
};

const LOCAL_PROJECT_FINGERPRINT_PREFIX = 'project:';
const LOCAL_GLOBAL_FINGERPRINT_PREFIX = 'global:';

function formatLocalSkillsFingerprint(
  project: string | undefined,
  global: string | undefined
): string {
  return `${LOCAL_PROJECT_FINGERPRINT_PREFIX}${project ?? ''}|${LOCAL_GLOBAL_FINGERPRINT_PREFIX}${global ?? ''}`;
}

/** The host fingerprints a cached local entry was built from, to send back as `knownFingerprint`. */
function parseLocalSkillsFingerprint(
  value: string | undefined
): { project?: string; global?: string } | null {
  if (!value) return null;
  const [projectPart, globalPart] = value.split('|');
  if (
    !projectPart?.startsWith(LOCAL_PROJECT_FINGERPRINT_PREFIX) ||
    !globalPart?.startsWith(LOCAL_GLOBAL_FINGERPRINT_PREFIX)
  ) {
    return null;
  }
  const project = projectPart.slice(LOCAL_PROJECT_FINGERPRINT_PREFIX.length);
  const global = globalPart.slice(LOCAL_GLOBAL_FINGERPRINT_PREFIX.length);
  return { ...(project ? { project } : {}), ...(global ? { global } : {}) };
}

function parseGlobalSkillsFingerprint(value: string | undefined): string | undefined {
  if (!value?.startsWith(LOCAL_GLOBAL_FINGERPRINT_PREFIX) || value.includes('|')) return undefined;
  return value.slice(LOCAL_GLOBAL_FINGERPRINT_PREFIX.length) || undefined;
}

function normalizeSource(
  source: ProjectSkillsSource | null | undefined
): NormalizedProjectSkillsSource | null {
  if (!source) {
    return null;
  }
  const workspaceId = source.workspaceId.trim();
  if (!workspaceId) {
    return null;
  }

  if (source.kind === 'local') {
    const machineId = source.machineId.trim();
    const localProjectId = source.localProjectId.trim();
    if (!machineId || !localProjectId) {
      return null;
    }
    return {
      kind: 'local',
      workspaceId,
      machineId,
      localProjectId,
    };
  }

  if (source.kind === 'global') {
    const machineId = source.machineId.trim();
    if (!machineId) {
      return null;
    }
    return {
      kind: 'global',
      workspaceId,
      machineId,
    };
  }

  const repoFullName = source.repoFullName.trim();
  if (!repoFullName) {
    return null;
  }
  return {
    kind: 'github',
    workspaceId,
    repoFullName,
  };
}

function getAgentConfigsForSource(
  source: NormalizedProjectSkillsSource | null,
  agentConfigs: readonly AgentConfigMeta[]
): AgentConfigMeta[] {
  if (!source) {
    return [];
  }
  return source.kind === 'github'
    ? [...agentConfigs]
    : agentConfigs.filter((config) => config.machineId === source.machineId);
}

function getRegisteredDirsForSource(
  source: NormalizedProjectSkillsSource | null,
  agentConfigs: readonly AgentConfigMeta[]
): RegisteredSkillDirsByScope {
  const configs = getAgentConfigsForSource(source, agentConfigs);
  // System and global skills both ride the machine home scan, so they surface
  // for the same source kinds.
  const includesGlobal = source?.kind === 'local' || source?.kind === 'global';
  return {
    project: source?.kind === 'global' ? new Set() : getRegisteredSkillDirs(configs),
    global: includesGlobal ? getRegisteredGlobalSkillDirs(configs) : new Set(),
    system: includesGlobal ? getRegisteredSystemSkillDirs(configs) : new Set(),
  };
}

function annotateAndSortGroups(
  groups: readonly ProjectSkillGroup[],
  registeredDirs: RegisteredSkillDirsByScope
): ProjectSkillResolvedGroup[] {
  return groups
    .map((group) => {
      const scopeDirs =
        group.scope === 'system'
          ? registeredDirs.system
          : group.scope === 'global'
            ? registeredDirs.global
            : registeredDirs.project;
      const registration: ProjectSkillGroupRegistration = scopeDirs.has(group.dir)
        ? 'registered'
        : 'found';
      return {
        ...group,
        registration,
      };
    })
    .sort((left, right) => {
      if (left.scope !== right.scope) {
        return compareProjectSkillScope(left.scope, right.scope);
      }
      if (left.registration !== right.registration) {
        return left.registration === 'registered' ? -1 : 1;
      }
      return left.dir.localeCompare(right.dir);
    });
}

function stateFromCache(
  entry: ProjectSkillsCacheEntry,
  status: ProjectSkillsStatus
): ProjectSkillsInternalState {
  return {
    status,
    rawGroups: entry.groups,
    stale: false,
    fetchedAt: entry.fetchedAt,
  };
}

export function useProjectSkills(
  sourceInput: ProjectSkillsSource | null | undefined
): ProjectSkillsState {
  const runtime = useAtomValue(runtimeAtom);
  const requestedByUserId = useAtomValue(userAtom)?.id ?? null;
  const agentConfigs = useAtomValue(getAllAgentConfigAtom);
  const inputKind = sourceInput?.kind ?? null;
  const inputWorkspaceId = sourceInput?.workspaceId ?? '';
  const inputMachineId =
    sourceInput?.kind === 'local' || sourceInput?.kind === 'global' ? sourceInput.machineId : '';
  const inputLocalProjectId = sourceInput?.kind === 'local' ? sourceInput.localProjectId : '';
  const inputRepoFullName = sourceInput?.kind === 'github' ? sourceInput.repoFullName : '';
  const source = useMemo(() => {
    if (inputKind === 'local') {
      return normalizeSource({
        kind: 'local',
        workspaceId: inputWorkspaceId,
        machineId: inputMachineId,
        localProjectId: inputLocalProjectId,
      });
    }
    if (inputKind === 'global') {
      return normalizeSource({
        kind: 'global',
        workspaceId: inputWorkspaceId,
        machineId: inputMachineId,
      });
    }
    if (inputKind === 'github') {
      return normalizeSource({
        kind: 'github',
        workspaceId: inputWorkspaceId,
        repoFullName: inputRepoFullName,
      });
    }
    return null;
  }, [inputKind, inputLocalProjectId, inputMachineId, inputRepoFullName, inputWorkspaceId]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [state, setState] = useState<ProjectSkillsInternalState>(EMPTY_INTERNAL_STATE);
  const scanDirs = useMemo(() => getSkillScanCandidateDirs(), []);
  const registeredDirs = useMemo(
    () => getRegisteredDirsForSource(source, agentConfigs),
    [agentConfigs, source]
  );
  const groups = useMemo(
    () => annotateAndSortGroups(state.rawGroups, registeredDirs),
    [registeredDirs, state.rawGroups]
  );
  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  const sourceCacheKey = useMemo(() => {
    if (!source || !requestedByUserId) {
      return null;
    }
    if (source.kind === 'local') {
      return getLocalProjectSkillsCacheKey(
        requestedByUserId,
        source.workspaceId,
        source.machineId,
        source.localProjectId
      );
    }
    if (source.kind === 'global') {
      return getMachineGlobalSkillsCacheKey(
        requestedByUserId,
        source.workspaceId,
        source.machineId
      );
    }
    return getGitHubProjectSkillsCacheKey(
      requestedByUserId,
      source.workspaceId,
      source.repoFullName
    );
  }, [requestedByUserId, source]);

  useEffect(() => {
    if (!source || !sourceCacheKey) {
      setState(EMPTY_INTERNAL_STATE);
      return undefined;
    }

    let cancelled = false;

    const load = async (): Promise<void> => {
      const cached = await readProjectSkillsCacheEntry(sourceCacheKey);
      if (cancelled) {
        return;
      }

      if (cached) {
        setState(stateFromCache(cached, 'refreshing'));
      } else {
        setState({ status: 'loading', rawGroups: [], stale: false });
      }

      // SWR cache hit: the source is unchanged, so keep the cached groups and
      // only bump fetchedAt. Shared by the local (content fingerprint) and
      // GitHub (commit sha) freshness checks below.
      const reuseCachedEntry = async (entry: ProjectSkillsCacheEntry): Promise<void> => {
        const refreshed: ProjectSkillsCacheEntry = { ...entry, fetchedAt: getServerNow() };
        await writeProjectSkillsCacheEntry(refreshed);
        if (!cancelled) {
          setState(stateFromCache(refreshed, 'ready'));
        }
      };

      try {
        if (source.kind === 'local') {
          if (!runtime || !requestedByUserId) {
            throw new Error('Local project control is unavailable.');
          }
          const transport = createLocalProjectSkillsTransport({
            workspaceId: source.workspaceId as WorkspaceId,
            machineId: source.machineId as MachineId,
            localProjectId: source.localProjectId as LocalProjectId,
            requestedByUserId,
            requestLocalProjectControl: (request, requestOptions) =>
              runtime.requestLocalProjectControl(request, requestOptions),
          });
          const knownParts = parseLocalSkillsFingerprint(cached?.contentFingerprint);
          const [projectResult, globalResult] = await Promise.all([
            transport.listSkills({ skillDirs: scanDirs, knownFingerprint: knownParts?.project }),
            transport.listGlobalSkills({ knownFingerprint: knownParts?.global }),
          ]);
          if (cancelled) {
            return;
          }

          const contentFingerprint = formatLocalSkillsFingerprint(
            projectResult.contentFingerprint,
            globalResult.contentFingerprint
          );
          if (cached && cached.contentFingerprint === contentFingerprint) {
            await reuseCachedEntry(cached);
            return;
          }
          const combinedGroups = [
            ...(projectResult.unchanged
              ? (cached?.groups.filter((group) => group.scope === 'project') ?? [])
              : projectResult.groups),
            ...(globalResult.unchanged
              ? (cached?.groups.filter((group) => group.scope !== 'project') ?? [])
              : globalResult.groups),
          ];

          const nextEntry: ProjectSkillsCacheEntry = {
            key: sourceCacheKey,
            groups: combinedGroups,
            source: 'local',
            contentFingerprint,
            knownDirsVersion: KNOWN_SKILL_DIRS_VERSION,
            fetchedAt: getServerNow(),
          };
          await writeProjectSkillsCacheEntry(nextEntry);
          if (!cancelled) {
            setState(stateFromCache(nextEntry, 'ready'));
          }
          return;
        }

        if (source.kind === 'global') {
          if (!runtime || !requestedByUserId) {
            throw new Error('Local project control is unavailable.');
          }
          const transport = createLocalProjectSkillsTransport({
            workspaceId: source.workspaceId as WorkspaceId,
            machineId: source.machineId as MachineId,
            requestedByUserId,
            requestLocalProjectControl: (request, requestOptions) =>
              runtime.requestLocalProjectControl(request, requestOptions),
          });
          const globalResult = await transport.listGlobalSkills({
            knownFingerprint: parseGlobalSkillsFingerprint(cached?.contentFingerprint),
          });
          if (cancelled) {
            return;
          }

          const contentFingerprint = `${LOCAL_GLOBAL_FINGERPRINT_PREFIX}${globalResult.contentFingerprint ?? ''}`;
          if (cached && cached.contentFingerprint === contentFingerprint) {
            await reuseCachedEntry(cached);
            return;
          }

          const nextEntry: ProjectSkillsCacheEntry = {
            key: sourceCacheKey,
            groups: globalResult.groups,
            source: 'global',
            contentFingerprint,
            knownDirsVersion: KNOWN_SKILL_DIRS_VERSION,
            fetchedAt: getServerNow(),
          };
          await writeProjectSkillsCacheEntry(nextEntry);
          if (!cancelled) {
            setState(stateFromCache(nextEntry, 'ready'));
          }
          return;
        }

        const head = await withGitHubTokenRetry(source.workspaceId, source.repoFullName, (token) =>
          githubFetchDefaultBranchHead(token, source.repoFullName)
        );
        if (cancelled) {
          return;
        }

        if (cached && cached.commitSha === head.headSha) {
          await reuseCachedEntry(cached);
          return;
        }

        const result = await withGitHubTokenRetry(
          source.workspaceId,
          source.repoFullName,
          (token) =>
            githubFetchProjectSkillsAtCommit(token, source.repoFullName, head.headSha, scanDirs)
        );
        if (cancelled) {
          return;
        }

        const nextEntry: ProjectSkillsCacheEntry = {
          key: sourceCacheKey,
          groups: result.groups,
          source: 'github',
          commitSha: head.headSha,
          contentFingerprint: result.contentFingerprint,
          knownDirsVersion: KNOWN_SKILL_DIRS_VERSION,
          fetchedAt: getServerNow(),
        };
        await writeProjectSkillsCacheEntry(nextEntry);
        if (!cancelled) {
          setState(stateFromCache(nextEntry, 'ready'));
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setState((previous) => ({
          ...previous,
          status: 'error',
          error: message,
          stale: previous.rawGroups.length > 0,
        }));
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [requestedByUserId, refreshNonce, runtime, scanDirs, source, sourceCacheKey]);

  return {
    ...state,
    groups,
    refresh,
  };
}
