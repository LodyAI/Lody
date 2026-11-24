import { defineMachinePlugin } from '@lody/plugin-sdk/machine';
import type { PluginStorage } from '@lody/plugin-sdk';
import {
  issueAttachmentSource,
  listIssuesQuery,
  sessionScratchpadQuery,
  togglePinMutation,
  type IssueRow,
} from './shared';

const pinKey = (projectId: string, issueId: string) => JSON.stringify(['pin', projectId, issueId]);

function trackerApiKey(
  config: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined
): string | undefined {
  const raw = config?.TRACKER_API_KEY;
  return typeof raw === 'string' ? raw : undefined;
}

async function fetchTrackerIssues(
  apiKey: string | undefined,
  storage: PluginStorage,
  projectId: string | undefined,
  query: string,
  signal: AbortSignal
): Promise<IssueRow[]> {
  if (!apiKey || signal.aborted) return [];
  const sample: IssueRow[] = [
    {
      id: 'iss_101',
      identifier: 'LODY-101',
      title: 'Extract tool result renderers into plugin SDK',
      state: 'blocked',
      pinned: projectId !== undefined && (await storage.get(pinKey(projectId, 'iss_101'))) === true,
      url: 'https://linear.app/example/issue/LODY-101',
      pullRequestUrl: 'https://github.com/lodyai/lody/pull/2906',
    },
  ];
  const q = query.trim().toLowerCase();
  return q
    ? sample.filter(
        (item) => item.identifier.toLowerCase().includes(q) || item.title.toLowerCase().includes(q)
      )
    : sample;
}

export default defineMachinePlugin((machine) => {
  machine.attachmentSource(issueAttachmentSource, {
    async search(ctx, query) {
      const items = await fetchTrackerIssues(
        trackerApiKey(ctx.config),
        ctx.storage,
        ctx.project?.projectId,
        query,
        ctx.signal
      );
      return items.map((item) => ({
        id: item.id,
        title: `${item.identifier} ${item.title}`,
        subtitle: item.state,
        url: item.url,
      }));
    },
    async resolve(ctx, itemId) {
      const items = await fetchTrackerIssues(
        trackerApiKey(ctx.config),
        ctx.storage,
        ctx.project?.projectId,
        '',
        ctx.signal
      );
      const found = items.find((item) => item.id === itemId);
      if (!found) throw new Error(`Issue ${itemId} not found`);
      return {
        title: `${found.identifier}: ${found.title}`,
        url: found.url,
        markdown: `## ${found.identifier}: ${found.title}\n\nState: ${found.state}\nURL: ${found.url}`,
        metadata: { identifier: found.identifier, state: found.state },
      };
    },
  });

  machine.query(listIssuesQuery, async (ctx, input) => {
    return fetchTrackerIssues(
      trackerApiKey(ctx.config),
      ctx.storage,
      ctx.target.projectId,
      input.query,
      ctx.signal
    );
  });

  machine.mutation(togglePinMutation, async (ctx, input) => {
    const key = pinKey(ctx.target.projectId, input.issueId);
    if (input.pinned) await ctx.storage.set(key, true);
    else await ctx.storage.delete(key);
    ctx.invalidate(listIssuesQuery, ctx.target);
    return { ok: true as const };
  });

  machine.query(sessionScratchpadQuery, async (ctx) => {
    const issue = await ctx.storage.get(JSON.stringify(['linked', ctx.target.sessionId]));
    return { linkedIdentifier: typeof issue === 'string' ? issue : null };
  });
});
