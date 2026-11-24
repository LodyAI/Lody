import {
  getSkillScanCandidateDirs,
  githubFetchPullRequestDetails,
  type SessionMeta,
  type MachineId,
} from '@lody/shared';
import type { ScopeTarget, PluginScope } from '@lody/plugin-sdk';
import type { WorkspaceRuntime } from '../atoms/runtime';
import type { VisibleLocalProjectEntry } from '../lib/visible-local-project-index';
import { createLocalProjectRpcFileTransport } from '../lib/local-project-rpc-file-provider';
import { createLocalProjectSkillsTransport } from '../lib/local-project-skills-provider';
import { withGitHubTokenRetry } from '../lib/github-token';
import { getIpcServices } from '../lib/electron-ipc-client';
import { decodeFilePreviewText } from '../lib/code-collab-session-file-provider';
export async function readWorkspaceResource(
  runtime: WorkspaceRuntime,
  account: string | null,
  machines: ReadonlySet<string>,
  projects: ReadonlyMap<string, VisibleLocalProjectEntry>,
  sessions: readonly SessionMeta[],
  local: string | undefined,
  target: ScopeTarget<PluginScope>,
  id: string,
  input: unknown,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  if (!account || !('machineId' in target)) throw Error('Machine unavailable');
  const s =
    'sessionId' in target
      ? sessions.find((s) => s.id === target.sessionId && s.machineId === target.machineId)
      : undefined;
  if ('sessionId' in target ? !s : !machines.has(target.machineId))
    throw Error('Resource unavailable');
  const machineId = target.machineId as MachineId;
  const projectId =
    s?.project?.kind === 'local'
      ? s.project.localProjectId
      : 'projectId' in target
        ? target.projectId
        : undefined;
  const p = projectId ? projects.get(`${machineId}:${projectId}`) : undefined;
  const args = {
    workspaceId: runtime.workspaceId,
    machineId,
    requestedByUserId: account,
    requestLocalProjectControl: runtime.requestLocalProjectControl,
  };
  const a = (input ?? {}) as {
    path: string;
    maxBytes?: number;
    number?: number;
    url?: string;
    turnId?: string;
  };
  if (id === 'skills') {
    if (projectId && !p) throw Error('Project unavailable');
    const transport = createLocalProjectSkillsTransport({ ...args, localProjectId: p?.project.id });
    const results = await Promise.all([
      transport.listGlobalSkills(),
      ...(p ? [transport.listSkills({ skillDirs: getSkillScanCandidateDirs() })] : []),
    ]);
    return {
      items: results.flatMap((r) =>
        r.groups.flatMap((g) =>
          g.skills.map((skill) => ({
            skillId: skill.id,
            name: skill.name,
            description: skill.description,
            source: g.scope === 'global' ? 'user' : g.scope === 'project' ? 'repository' : 'system',
          }))
        )
      ),
    };
  }
  if (id === 'pullRequests') {
    const repo = p?.project.githubRepoFullName;
    if (!repo) throw Error('Repository unavailable');
    const number = a.number ?? Number(a.url?.split('/').at(-1));
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      (a.url && a.url.toLowerCase() !== `https://github.com/${repo}/pull/${number}`.toLowerCase())
    )
      throw Error('Invalid pull request');
    const pr = await withGitHubTokenRetry(runtime.workspaceId, repo, (t) =>
      githubFetchPullRequestDetails(t, repo, number)
    );
    return {
      number,
      url: pr.htmlUrl,
      headSha: pr.headSha,
      state: pr.merged ? 'merged' : pr.state,
      draft: pr.draft,
      ciStatus: 'unknown',
    };
  }
  if (id === 'filePreview') {
    const maxBytes = a.maxBytes ?? 65536;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !a.path ||
      a.path.split(/[\\/]/).some((x) => x === '..' || !x) ||
      /^\w:/.test(a.path)
    )
      throw Error('Invalid file preview');
    if (s) {
      const r = await runtime.requestFilePreview(
        machineId,
        { sessionId: s.id, path: a.path, maxBytes },
        { ownerSessionId: s.parentSessionId ?? s.id }
      );
      if ((r.status !== 'ok' && r.status !== 'resource') || r.external)
        throw Error('File unavailable');
      let content: string | undefined;
      if (r.kind === 'text') {
        if (r.status === 'resource') {
          if (r.sizeBytes > maxBytes) throw Error('File exceeds preview limit');
          content = await (await fetch(r.url, { signal })).text();
        } else content = await decodeFilePreviewText(r);
      }
      return { path: r.path, kind: 'file', content, truncated: false };
    }
    if (!p) throw Error('Project unavailable');
    const r = await createLocalProjectRpcFileTransport({
      ...args,
      localProjectId: p.project.id,
    }).readFile({ relativePath: a.path, maxBytes });
    if (!r) throw Error('File unavailable');
    return {
      path: r.path,
      kind: 'file',
      content: r.encoding === 'base64' ? undefined : r.content,
      truncated: r.truncated,
    };
  }
  if (!s) throw Error('Session unavailable');
  if (id === 'automations') {
    const r =
      machineId === local
        ? await getIpcServices()?.sessionControl.automation({
            workspaceId: runtime.workspaceId,
            machineId,
            sessionId: s.id,
            command: { type: 'list' },
          })
        : await runtime.requestSessionAutomationControl?.(machineId, s.id, account, {
            type: 'list',
          });
    if (r?.type !== 'list') throw Error('Automations unavailable');
    return {
      items: r.waits.map((w) => ({
        automationId: w.id,
        reason: w.reason,
        expiresAt: w.expiresAt,
        status:
          w.state === 'waiting' || w.state === 'checking'
            ? 'active'
            : w.state === 'cancelled'
              ? 'cancelled'
              : 'completed',
      })),
    };
  }
  if (id === 'sessionDiff' && !a.turnId) {
    const r = await runtime.requestCodeCollabOpenAllChangesDiff(
      machineId,
      { sessionId: s.id },
      { ownerSessionId: s.parentSessionId ?? s.id }
    );
    if (r?.status !== 'ok') throw Error('Diff unavailable');
    return {
      files: r.entries.flatMap((e) =>
        e.status === 'ok' || e.status === 'deferred'
          ? [
              {
                path: e.path,
                status:
                  e.status === 'ok' && e.oldSnapshot.kind === 'missing'
                    ? 'added'
                    : e.status === 'ok' && e.newSnapshot.kind === 'missing'
                      ? 'deleted'
                      : 'modified',
                additions: e.add ?? 0,
                deletions: e.del ?? 0,
              },
            ]
          : []
      ),
    };
  }
  if (id === 'sessionDiff' && a.turnId) {
    const store = await runtime.acquireSessionStore(s.id);
    try {
      await store.history.ready;
      const index = store.history.indexOf(a.turnId);
      if (index < 0) throw Error('Turn unavailable');
      const range = store.history.acquireRange(index, index + 1);
      try {
        await range.ready;
        return {
          files: (store.history.turn(index)?.fileDiff ?? []).map((f) => ({
            path: f.filePath,
            status: f.cc?.deleted ? 'deleted' : f.cc?.base === 'missing' ? 'added' : 'modified',
            additions: f.add,
            deletions: f.del,
          })),
        };
      } finally {
        range.release();
      }
    } finally {
      runtime.releaseSessionStoreRef(s.id);
    }
  }
  throw Error('Unknown resource');
}
