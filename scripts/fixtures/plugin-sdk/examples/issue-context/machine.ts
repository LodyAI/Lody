import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineMachinePlugin } from '@lody/plugin-sdk/machine';
import {
  issueAttachmentSource,
  issueStateObservation,
  listIssuesQuery,
  sessionScratchpadQuery,
  togglePinMutation,
  type IssueRow,
} from './shared';

interface PersistedIssueState {
  readonly pinnedByProject: Readonly<Record<string, readonly string[]>>;
  readonly linkedBySession: Readonly<Record<string, string>>;
}

const EMPTY_STATE: PersistedIssueState = {
  pinnedByProject: {},
  linkedBySession: {},
};

function stateFilePath(dataDir: string): string {
  return path.join(dataDir, 'issue-context-state.json');
}

async function readPersistedState(dataDir: string): Promise<PersistedIssueState> {
  try {
    const raw = await readFile(stateFilePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedIssueState>;
    return {
      pinnedByProject: parsed.pinnedByProject ?? {},
      linkedBySession: parsed.linkedBySession ?? {},
    };
  } catch {
    return EMPTY_STATE;
  }
}

async function writePersistedState(dataDir: string, next: PersistedIssueState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const targetPath = stateFilePath(dataDir);
  const tempPath = `${targetPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(next, null, 2), 'utf8');
  await rename(tempPath, targetPath);
}

async function fetchTrackerIssues(
  apiKey: string | undefined,
  pinnedIds: ReadonlySet<string>,
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
      pinned: pinnedIds.has('iss_101'),
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
      const state = await readPersistedState(ctx.dataDir);
      const pinned = new Set(
        ctx.project ? (state.pinnedByProject[ctx.project.projectId] ?? []) : []
      );
      const items = await fetchTrackerIssues(ctx.env.TRACKER_API_KEY, pinned, query, ctx.signal);
      return items.map((item) => ({
        id: item.id,
        title: `${item.identifier} ${item.title}`,
        subtitle: item.state,
        url: item.url,
      }));
    },
    async resolve(ctx, itemId) {
      const items = await fetchTrackerIssues(ctx.env.TRACKER_API_KEY, new Set(), '', ctx.signal);
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
    const state = await readPersistedState(ctx.dataDir);
    const pinned = new Set(state.pinnedByProject[ctx.target.projectId] ?? []);
    return fetchTrackerIssues(ctx.env.TRACKER_API_KEY, pinned, input.query, ctx.signal);
  });

  machine.mutation(togglePinMutation, async (ctx, input) => {
    const state = await readPersistedState(ctx.dataDir);
    const nextPinned = new Set(state.pinnedByProject[ctx.target.projectId] ?? []);
    if (input.pinned) nextPinned.add(input.issueId);
    else nextPinned.delete(input.issueId);

    await writePersistedState(ctx.dataDir, {
      ...state,
      pinnedByProject: {
        ...state.pinnedByProject,
        [ctx.target.projectId]: Array.from(nextPinned),
      },
    });
    ctx.invalidate(listIssuesQuery, ctx.target);
    return { ok: true as const };
  });

  machine.query(sessionScratchpadQuery, async (ctx) => {
    const state = await readPersistedState(ctx.dataDir);
    return {
      linkedIdentifier: state.linkedBySession[ctx.target.sessionId] ?? null,
    };
  });

  machine.observation(issueStateObservation, async (ctx, input) => {
    const items = await fetchTrackerIssues(
      ctx.env.TRACKER_API_KEY,
      new Set(),
      input.identifier,
      ctx.signal
    );
    const match = items.find((item) => item.identifier === input.identifier);
    return {
      value: { state: match ? match.state : ('unknown' as const) },
      observedAt: Date.now(),
    };
  });
});
