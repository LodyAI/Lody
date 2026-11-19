import {
  defineMutation,
  defineQuery,
  hostQueries,
  type PluginCallErrorCode,
  type ProjectRef,
  type WorkspaceRef,
} from '@lody/plugin-sdk';
import { useHost, useMutation, useQuery, type ProjectPageProps } from '@lody/plugin-sdk/client';
import { defineMachinePlugin } from '@lody/plugin-sdk/machine';
import type { PluginManifest } from '@lody/plugin-sdk/manifest';
import { z } from 'zod';
import { runSuiteTool } from './examples/test-report/shared';

const workspaceBoardQuery = defineQuery('workspace', 'board.summary', {
  input: z.object({ limit: z.number().int().default(10) }),
  output: z.object({ count: z.number().int() }),
});

const projectPinMutation = defineMutation('project', 'item.pin', {
  input: z.object({ itemId: z.string() }),
  output: z.object({ pinned: z.boolean() }),
});

const recoverReviewMutation = defineMutation('project', 'review.ensure', {
  input: z.object({ prNumber: z.number().int(), headSha: z.string() }),
  output: z.object({ sessionId: z.string() }),
});

export const validManifest: PluginManifest = {
  id: 'test-report',
  version: '0.1.0',
  sdk: '^1.0.0',
  title: 'Test Report',
  client: './dist/client.js',
  machine: './dist/machine.js',
  skills: ['test-triage'],
  env: {
    TRACKER_API_KEY: {
      description: 'API token for issue lookup on the daemon.',
      secret: true,
    },
  },
};

export const headlessOnlyManifest: PluginManifest = {
  id: 'ci-sentinel',
  version: '0.1.0',
  sdk: '^1.0.0',
  title: 'CI Sentinel',
  machine: './dist/machine.js',
  skills: ['ci-triage'],
};

export const clientOnlyManifest: PluginManifest = {
  id: 'focus-sidebar',
  version: '0.1.0',
  sdk: '^1.0.0',
  title: 'Focus Sidebar',
  client: './dist/client.js',
};

export const invalidSdkRangeManifest: PluginManifest = {
  id: 'bad-sdk',
  version: '0.1.0',
  // @ts-expect-error Manifest must target a supported SDK major range.
  sdk: '^2.0.0',
  title: 'Invalid SDK',
};

export const retriableOfflineCode: PluginCallErrorCode = 'machine_offline';

export function verifyClientTypeSafety(
  workspace: WorkspaceRef,
  project: ProjectRef,
  pageProps: ProjectPageProps
) {
  const host = useHost();

  const okWorkspaceRead = useQuery(workspace, workspaceBoardQuery, {});
  if (okWorkspaceRead.status === 'ready') {
    const count: number = okWorkspaceRead.data.count;
    void count;
  }

  const byKeyRead = useQuery(project, hostQueries.sessions, {
    createdByMe: true,
    createdByPlugin: true,
    idempotencyKey: 'review/42/abc123',
    machineId: project.machineId,
  });
  if (byKeyRead.status === 'ready') {
    const key: string | undefined = byKeyRead.data.items[0]?.idempotencyKey;
    void key;
  }

  // @ts-expect-error Project-scoped query cannot be called with a WorkspaceRef.
  useQuery(workspace, hostQueries.worktrees, {});

  // @ts-expect-error Workspace-scoped query cannot be called with a ProjectRef.
  useQuery(project, hostQueries.projects, {});

  const pin = useMutation(project, projectPinMutation);
  // @ts-expect-error Mutation input is validated against the Zod input schema.
  void pin.mutate({ itemId: 42 });

  // @ts-expect-error Raw ID objects cannot forge a branded SessionRef capability.
  host.sessions.open({ workspaceId: 'lw_1', machineId: 'm_1', sessionId: 's_1' });

  // @ts-expect-error Route params are immutable; navigation goes through host.pages.openProject.
  pageProps.params.pr = '99';
}

export const machineContractChecks = defineMachinePlugin((machine) => {
  machine.query(workspaceBoardQuery, (ctx, input) => {
    const limit: number = input.limit;
    // @ts-expect-error Workspace-scoped context does not expose projectId.
    void ctx.target.projectId;
    return { count: limit };
  });

  machine.mutation(recoverReviewMutation, async (ctx, input) => {
    const key = `review/${input.prNumber}/${input.headSha}`;
    const existing = await ctx.host.read(ctx.target, hostQueries.sessions, {
      createdByMe: true,
      createdByPlugin: true,
      idempotencyKey: key,
      limit: 1,
    });
    if (existing.items[0]) {
      return { sessionId: existing.items[0].session.sessionId };
    }
    const created = await ctx.host.sessions.create(ctx.target, {
      idempotencyKey: key,
      prompt: `Review PR #${input.prNumber} at ${input.headSha}.`,
    });
    return { sessionId: created.sessionId };
  });

  // @ts-expect-error Tool handler return type must satisfy the tool output schema.
  machine.tool(runSuiteTool, () => ({ wrongField: true }));

  return () => {};
});
