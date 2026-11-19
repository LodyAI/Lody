import { defineMachinePlugin } from '@lody/plugin-sdk/machine';
import {
  issueAttachmentSource,
  issueStateObservation,
  listIssuesQuery,
  togglePinMutation,
  type IssueRow,
} from './shared';

const pinnedIds = new Set<string>();

async function fetchTrackerIssues(
  apiKey: string | undefined,
  query: string,
  signal: AbortSignal
): Promise<IssueRow[]> {
  if (!apiKey || signal.aborted) return [];
  const sample: IssueRow[] = [
    {
      id: 'iss_101',
      identifier: 'LODY-101',
      title: 'Extract tool result renderers into plugin SDK',
      state: 'in_progress',
      pinned: pinnedIds.has('iss_101'),
      url: 'https://linear.app/example/issue/LODY-101',
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
      const items = await fetchTrackerIssues(ctx.env.TRACKER_API_KEY, query, ctx.signal);
      return items.map((item) => ({
        id: item.id,
        title: `${item.identifier} ${item.title}`,
        subtitle: item.state,
        url: item.url,
      }));
    },
    async resolve(ctx, itemId) {
      const items = await fetchTrackerIssues(ctx.env.TRACKER_API_KEY, '', ctx.signal);
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
    return fetchTrackerIssues(ctx.env.TRACKER_API_KEY, input.query, ctx.signal);
  });

  machine.mutation(togglePinMutation, async (ctx, input) => {
    if (input.pinned) pinnedIds.add(input.issueId);
    else pinnedIds.delete(input.issueId);
    ctx.invalidate(listIssuesQuery, ctx.target);
    return { ok: true as const };
  });

  machine.observation(issueStateObservation, async (ctx, input) => {
    const items = await fetchTrackerIssues(ctx.env.TRACKER_API_KEY, input.identifier, ctx.signal);
    const match = items.find((item) => item.identifier === input.identifier);
    return {
      value: { state: match ? match.state : ('unknown' as const) },
      observedAt: Date.now(),
    };
  });
});
