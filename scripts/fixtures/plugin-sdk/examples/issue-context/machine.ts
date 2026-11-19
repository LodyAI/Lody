import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineMachinePlugin } from '@lody/plugin-sdk/machine';
import { z } from 'zod';
import {
  issueAttachmentSource,
  issueStateObservation,
  listIssuesQuery,
  sessionScratchpadQuery,
  togglePinMutation,
  type IssueRow,
} from './shared';

const persistedIssueStateSchema = z.strictObject({
  pinnedByProject: z.record(z.string(), z.array(z.string())),
  linkedBySession: z.record(z.string(), z.string()),
});

type PersistedIssueState = z.infer<typeof persistedIssueStateSchema>;

const EMPTY_STATE: PersistedIssueState = {
  pinnedByProject: {},
  linkedBySession: {},
};

function stateFilePath(dataDir: string): string {
  return path.resolve(dataDir, 'issue-context-state.json');
}

async function readPersistedState(dataDir: string): Promise<PersistedIssueState> {
  let raw: string;
  try {
    raw = await readFile(stateFilePath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return EMPTY_STATE;
    throw error;
  }
  return persistedIssueStateSchema.parse(JSON.parse(raw));
}

async function writePersistedState(dataDir: string, next: PersistedIssueState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const targetPath = stateFilePath(dataDir);
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, targetPath);
  } catch (error) {
    // An exclusive-create collision never gives this writer ownership of that file.
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      try {
        await rm(tempPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'State write and temporary-file cleanup failed'
        );
      }
    }
    throw error;
  }
}

// The host owns one active machine instance. Coordinate its complete read/modify/write
// transactions per state file; a failed transaction must not poison the next attempt.
const pendingUpdates = new Map<string, Promise<void>>();

function updatePersistedState(
  dataDir: string,
  update: (state: PersistedIssueState) => PersistedIssueState
): Promise<void> {
  const key = stateFilePath(dataDir);
  const write = (pendingUpdates.get(key) ?? Promise.resolve()).then(async () => {
    const state = await readPersistedState(dataDir);
    await writePersistedState(dataDir, update(state));
  });
  const settled = write.then(
    () => {},
    () => {}
  );
  pendingUpdates.set(key, settled);
  void settled.then(() => {
    if (pendingUpdates.get(key) === settled) pendingUpdates.delete(key);
  });
  return write;
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
    await updatePersistedState(ctx.dataDir, (state) => {
      const nextPinned = new Set(state.pinnedByProject[ctx.target.projectId] ?? []);
      if (input.pinned) nextPinned.add(input.issueId);
      else nextPinned.delete(input.issueId);
      return {
        ...state,
        pinnedByProject: {
          ...state.pinnedByProject,
          [ctx.target.projectId]: Array.from(nextPinned),
        },
      };
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
