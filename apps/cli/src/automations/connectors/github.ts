import type {
  GitHubTriggerConfig,
  GitHubTriggerEventKind,
  NormalizedTriggerEvent,
} from '@lody/shared';
import type { ConnectorHostContext, ConnectorPluginRuntime } from './types';

export interface GitHubConnectorCursor {
  seededAt: number;
  streamSince: Partial<Record<GitHubTriggerEventKind, number>>;
  etags: Record<string, string>;
  seenKeys: string[];
}

const MAX_SEEN_KEYS = 240;
const REQUEST_TIMEOUT_MS = 12_000;

function isBotLogin(login: string | undefined, userType: string | undefined): boolean {
  if (!login) return false;
  if (userType?.toLowerCase() === 'bot') return true;
  const lower = login.toLowerCase();
  return lower.endsWith('[bot]') || lower === 'dependabot' || lower === 'github-actions';
}

function cleanBodyText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return cleaned ? cleaned.slice(0, 1600) : undefined;
}

function extractLabelNames(rawLabels: unknown): string[] {
  if (!Array.isArray(rawLabels)) return [];
  const names: string[] = [];
  for (const label of rawLabels) {
    if (typeof label === 'string' && label.trim()) {
      names.push(label.trim().toLowerCase());
    } else if (
      label &&
      typeof label === 'object' &&
      typeof (label as { name?: unknown }).name === 'string'
    ) {
      const name = (label as { name: string }).name.trim().toLowerCase();
      if (name) names.push(name);
    }
  }
  return names;
}

function matchesLabelFilter(
  itemLabels: string[],
  requiredLabels: readonly string[] | undefined
): boolean {
  if (!requiredLabels || requiredLabels.length === 0) return true;
  const wanted = requiredLabels.map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return true;
  const present = new Set(itemLabels);
  return wanted.some((label) => present.has(label));
}

async function fetchGitHubJson<T>(args: {
  ctx: ConnectorHostContext;
  repoFullName: string;
  token: string;
  path: string;
  etag?: string;
}): Promise<{ notModified: true } | { notModified: false; data: T; etag?: string }> {
  const fetchFn = args.ctx.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${args.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Lody-Coordinator-Connector',
  };
  if (args.etag) {
    headers['If-None-Match'] = args.etag;
  }

  const response = await fetchFn(`https://api.github.com${args.path}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 304) {
    return { notModified: true };
  }
  if (response.status === 401) {
    throw new Error(`GitHub authentication expired or unauthorized for ${args.repoFullName}`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} on ${args.path}`);
  }

  const data = (await response.json()) as T;
  const nextEtag = response.headers.get('etag') ?? undefined;
  return { notModified: false, data, ...(nextEtag ? { etag: nextEtag } : {}) };
}

export const githubConnectorPlugin: ConnectorPluginRuntime<
  GitHubTriggerConfig,
  GitHubConnectorCursor
> = {
  pluginId: 'github',

  async checkAuth(ctx, repoHint = 'LodyAI/Lody') {
    const cred = await ctx.resolveGitHubCredential(repoHint);
    if (!cred) return { status: 'needs_auth' };
    return {
      status: cred.source === 'gh' ? 'local_cli' : 'connected',
      source: cred.source,
    };
  },

  seedCursor(config, now) {
    const streamSince: Partial<Record<GitHubTriggerEventKind, number>> = {};
    for (const kind of config.events) {
      streamSince[kind] = now;
    }
    return {
      seededAt: now,
      streamSince,
      etags: {},
      seenKeys: [],
    };
  },

  async pollDelta(ctx, config, prevCursor, now) {
    const cursor: GitHubConnectorCursor = prevCursor
      ? {
          seededAt: prevCursor.seededAt || now,
          streamSince: { ...prevCursor.streamSince },
          etags: { ...prevCursor.etags },
          seenKeys: [...(prevCursor.seenKeys ?? [])],
        }
      : this.seedCursor(config, now);

    // Ensure newly added event types on an edited trigger start from `now` rather than epoch 0.
    for (const kind of config.events) {
      if (typeof cursor.streamSince[kind] !== 'number') {
        cursor.streamSince[kind] = now;
      }
    }

    const credential = await ctx.resolveGitHubCredential(config.repoFullName);
    if (!credential) {
      throw new Error(
        `GitHub credential unavailable for ${config.repoFullName}. Connect GitHub in Settings or run "gh auth login".`
      );
    }

    const seen = new Set(cursor.seenKeys);
    const collected: NormalizedTriggerEvent[] = [];
    const wantedEvents = new Set<GitHubTriggerEventKind>(config.events);
    const repo = config.repoFullName;

    const recordEvent = (kind: GitHubTriggerEventKind, ev: NormalizedTriggerEvent) => {
      if (seen.has(ev.dedupKey)) return;
      seen.add(ev.dedupKey);
      cursor.seenKeys.push(ev.dedupKey);
      collected.push(ev);
      const prevMax = cursor.streamSince[kind] ?? cursor.seededAt;
      if (ev.occurredAt > prevMax) {
        cursor.streamSince[kind] = ev.occurredAt;
      }
    };

    try {
      if (wantedEvents.has('issue.opened')) {
        const sinceMs = cursor.streamSince['issue.opened'] ?? cursor.seededAt;
        const endpoint = `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=20`;
        const res = await fetchGitHubJson<Array<Record<string, unknown>>>({
          ctx,
          repoFullName: repo,
          token: credential.token,
          path: endpoint,
          etag: cursor.etags.issues,
        });
        if (!res.notModified) {
          if (res.etag) cursor.etags.issues = res.etag;
          for (const item of res.data) {
            if (item.pull_request) continue;
            const createdMs = typeof item.created_at === 'string' ? Date.parse(item.created_at) : 0;
            if (!Number.isFinite(createdMs) || createdMs <= sinceMs) continue;
            const user = (item.user ?? {}) as { login?: string; type?: string };
            const bot = isBotLogin(user.login, user.type);
            if (config.excludeBots && bot) continue;
            if (!matchesLabelFilter(extractLabelNames(item.labels), config.labels)) continue;
            const number = typeof item.number === 'number' ? item.number : 0;
            const title = typeof item.title === 'string' ? item.title : `Issue #${number}`;
            recordEvent('issue.opened', {
              dedupKey: `github:${repo}:issue.opened:${number}`,
              eventKind: 'issue.opened',
              occurredAt: createdMs,
              ...(user.login ? { actor: user.login } : {}),
              isBot: bot,
              title: `[Issue #${number}] ${title}`,
              cleanBody: cleanBodyText(item.body),
              ...(typeof item.html_url === 'string' ? { url: item.html_url } : {}),
              externalRefLabel: `${repo}#${number}`,
            });
          }
        }
      }

      if (wantedEvents.has('issue.commented')) {
        const sinceMs = cursor.streamSince['issue.commented'] ?? cursor.seededAt;
        const sinceIso = new Date(sinceMs).toISOString();
        const endpoint = `/repos/${repo}/issues/comments?sort=created&direction=desc&since=${encodeURIComponent(sinceIso)}&per_page=20`;
        const res = await fetchGitHubJson<Array<Record<string, unknown>>>({
          ctx,
          repoFullName: repo,
          token: credential.token,
          path: endpoint,
          etag: cursor.etags.comments,
        });
        if (!res.notModified) {
          if (res.etag) cursor.etags.comments = res.etag;
          for (const item of res.data) {
            const createdMs = typeof item.created_at === 'string' ? Date.parse(item.created_at) : 0;
            if (!Number.isFinite(createdMs) || createdMs <= sinceMs) continue;
            const user = (item.user ?? {}) as { login?: string; type?: string };
            const bot = isBotLogin(user.login, user.type);
            if (config.excludeBots && bot) continue;
            const commentId = item.id ?? createdMs;
            const issueUrl = typeof item.issue_url === 'string' ? item.issue_url : '';
            const numMatch = /\/issues\/(\d+)$/.exec(issueUrl);
            const numLabel = numMatch ? `#${numMatch[1]}` : 'comment';
            recordEvent('issue.commented', {
              dedupKey: `github:${repo}:issue.commented:${String(commentId)}`,
              eventKind: 'issue.commented',
              occurredAt: createdMs,
              ...(user.login ? { actor: user.login } : {}),
              isBot: bot,
              title: `New comment on ${repo}${numLabel} by @${user.login ?? 'unknown'}`,
              cleanBody: cleanBodyText(item.body),
              ...(typeof item.html_url === 'string' ? { url: item.html_url } : {}),
              externalRefLabel: `${repo}${numLabel}`,
            });
          }
        }
      }

      if (wantedEvents.has('pr.opened') || wantedEvents.has('pr.review_requested')) {
        const endpoint = `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=20`;
        const res = await fetchGitHubJson<Array<Record<string, unknown>>>({
          ctx,
          repoFullName: repo,
          token: credential.token,
          path: endpoint,
          etag: cursor.etags.pulls,
        });
        if (!res.notModified) {
          if (res.etag) cursor.etags.pulls = res.etag;
          for (const item of res.data) {
            const user = (item.user ?? {}) as { login?: string; type?: string };
            const bot = isBotLogin(user.login, user.type);
            if (config.excludeBots && bot) continue;
            if (!matchesLabelFilter(extractLabelNames(item.labels), config.labels)) continue;
            const number = typeof item.number === 'number' ? item.number : 0;
            const title = typeof item.title === 'string' ? item.title : `PR #${number}`;
            const createdMs = typeof item.created_at === 'string' ? Date.parse(item.created_at) : 0;
            const updatedMs = typeof item.updated_at === 'string' ? Date.parse(item.updated_at) : 0;

            if (
              wantedEvents.has('pr.opened') &&
              Number.isFinite(createdMs) &&
              createdMs > (cursor.streamSince['pr.opened'] ?? cursor.seededAt)
            ) {
              recordEvent('pr.opened', {
                dedupKey: `github:${repo}:pr.opened:${number}`,
                eventKind: 'pr.opened',
                occurredAt: createdMs,
                ...(user.login ? { actor: user.login } : {}),
                isBot: bot,
                title: `[PR #${number}] ${title}`,
                cleanBody: cleanBodyText(item.body),
                ...(typeof item.html_url === 'string' ? { url: item.html_url } : {}),
                externalRefLabel: `${repo}#${number}`,
              });
            }

            if (wantedEvents.has('pr.review_requested') && Number.isFinite(updatedMs)) {
              const reviewers = Array.isArray(item.requested_reviewers)
                ? (item.requested_reviewers as Array<{ login?: string }>)
                    .map((r) => r.login)
                    .filter((l): l is string => Boolean(l))
                : [];
              if (
                reviewers.length > 0 &&
                updatedMs > (cursor.streamSince['pr.review_requested'] ?? cursor.seededAt)
              ) {
                recordEvent('pr.review_requested', {
                  dedupKey: `github:${repo}:pr.review_requested:${number}:${reviewers.sort().join(',')}`,
                  eventKind: 'pr.review_requested',
                  occurredAt: updatedMs,
                  ...(user.login ? { actor: user.login } : {}),
                  isBot: bot,
                  title: `[Review requested: ${reviewers.map((r) => `@${r}`).join(', ')}] PR #${number}: ${title}`,
                  cleanBody: cleanBodyText(item.body),
                  ...(typeof item.html_url === 'string' ? { url: item.html_url } : {}),
                  externalRefLabel: `${repo}#${number}`,
                });
              }
            }
          }
        }
      }

      if (wantedEvents.has('workflow_run.failed')) {
        const sinceMs = cursor.streamSince['workflow_run.failed'] ?? cursor.seededAt;
        const endpoint = `/repos/${repo}/actions/runs?status=failure&per_page=15`;
        const res = await fetchGitHubJson<{ workflow_runs?: Array<Record<string, unknown>> }>({
          ctx,
          repoFullName: repo,
          token: credential.token,
          path: endpoint,
          etag: cursor.etags.workflows,
        });
        if (!res.notModified) {
          if (res.etag) cursor.etags.workflows = res.etag;
          for (const run of res.data.workflow_runs ?? []) {
            const updatedMs = typeof run.updated_at === 'string' ? Date.parse(run.updated_at) : 0;
            if (!Number.isFinite(updatedMs) || updatedMs <= sinceMs) continue;
            const runId = run.id ?? updatedMs;
            const name = typeof run.name === 'string' ? run.name : 'Workflow';
            const branch = typeof run.head_branch === 'string' ? run.head_branch : '';
            const actorObj = (run.actor ?? {}) as { login?: string; type?: string };
            const bot = isBotLogin(actorObj.login, actorObj.type);
            if (config.excludeBots && bot) continue;
            recordEvent('workflow_run.failed', {
              dedupKey: `github:${repo}:workflow_run.failed:${String(runId)}:${String(run.run_attempt ?? 1)}`,
              eventKind: 'workflow_run.failed',
              occurredAt: updatedMs,
              ...(actorObj.login ? { actor: actorObj.login } : {}),
              isBot: bot,
              title: `[CI Failed] ${name}${branch ? ` (${branch})` : ''}`,
              cleanBody:
                typeof run.display_title === 'string' ? run.display_title.slice(0, 600) : undefined,
              ...(typeof run.html_url === 'string' ? { url: run.html_url } : {}),
              externalRefLabel: `${repo} CI`,
            });
          }
        }
      }

      if (wantedEvents.has('release.published')) {
        const sinceMs = cursor.streamSince['release.published'] ?? cursor.seededAt;
        const endpoint = `/repos/${repo}/releases?per_page=10`;
        const res = await fetchGitHubJson<Array<Record<string, unknown>>>({
          ctx,
          repoFullName: repo,
          token: credential.token,
          path: endpoint,
          etag: cursor.etags.releases,
        });
        if (!res.notModified) {
          if (res.etag) cursor.etags.releases = res.etag;
          for (const rel of res.data) {
            if (rel.draft === true) continue;
            const publishedMs =
              typeof rel.published_at === 'string' ? Date.parse(rel.published_at) : 0;
            if (!Number.isFinite(publishedMs) || publishedMs <= sinceMs) continue;
            const tag = typeof rel.tag_name === 'string' ? rel.tag_name : 'release';
            const relName = typeof rel.name === 'string' && rel.name.trim() ? rel.name.trim() : tag;
            const authorObj = (rel.author ?? {}) as { login?: string; type?: string };
            recordEvent('release.published', {
              dedupKey: `github:${repo}:release.published:${tag}`,
              eventKind: 'release.published',
              occurredAt: publishedMs,
              ...(authorObj.login ? { actor: authorObj.login } : {}),
              title: `[Release ${tag}] ${relName}`,
              cleanBody: cleanBodyText(rel.body),
              ...(typeof rel.html_url === 'string' ? { url: rel.html_url } : {}),
              externalRefLabel: `${repo}@${tag}`,
            });
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('authentication expired')) {
        ctx.invalidateGitHubCredential(repo, credential);
      }
      throw error;
    }

    if (cursor.seenKeys.length > MAX_SEEN_KEYS) {
      cursor.seenKeys = cursor.seenKeys.slice(-MAX_SEEN_KEYS);
    }

    collected.sort((a, b) => a.occurredAt - b.occurredAt);
    return { events: collected, nextCursor: cursor };
  },
};
