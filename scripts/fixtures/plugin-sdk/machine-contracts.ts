import { defineMutation, defineQuery, hostQueries } from '@lody/plugin-sdk';
import { defineMachinePlugin } from '@lody/plugin-sdk/machine';
import { z } from 'zod';
import { runSuiteTool } from './examples/test-report/shared';

// @ts-expect-error Machine plugins cannot import browser client hooks or registries.
import('@lody/plugin-sdk/client');

const machineDigestQuery = defineQuery('machine', 'daemon.digest', {
  input: z.object({ limit: z.number().int().default(10) }),
  output: z.object({ count: z.number().int() }),
});

const sessionMonitorQuery = defineQuery('session', 'monitor.state', {
  input: z.object({}),
  output: z.object({ activeStep: z.string().nullable() }),
});

const recoverReviewMutation = defineMutation('project', 'review.ensure', {
  input: z.object({ prNumber: z.number().int(), headSha: z.string() }),
  output: z.object({ sessionId: z.string() }),
});

export const machineContractChecks = defineMachinePlugin((machine) => {
  machine.query(machineDigestQuery, (ctx, input) => {
    const limit: number = input.limit;
    const machineId: string = ctx.target.machineId;
    void machineId;
    // @ts-expect-error Machine-scoped context does not expose projectId.
    void ctx.target.projectId;
    return { count: limit };
  });

  machine.query(sessionMonitorQuery, async (ctx) => {
    const detail = await ctx.host.read(ctx.target, hostQueries.sessionDetail, {
      recentTurnLimit: 3,
    });
    return { activeStep: detail.recentTurns[0]?.previewText ?? null };
  });

  machine.mutation(recoverReviewMutation, async (ctx, input) => {
    const key = `review/${input.prNumber}/${input.headSha}`;
    const existing = await ctx.host.read(ctx.target, hostQueries.sessions, {
      createdByMe: true,
      createdByPlugin: true,
      archived: false,
      idempotencyKey: key,
      limit: 1,
    });
    if (existing.items[0]) {
      await ctx.host.sessions.send(existing.items[0].session, {
        idempotencyKey: `${key}:nudge`,
        prompt: `Re-check PR #${input.prNumber} at ${input.headSha}.`,
      });
      return { sessionId: existing.items[0].session.sessionId };
    }
    const created = await ctx.host.sessions.create(ctx.target, {
      idempotencyKey: key,
      pullRequestUrl: `https://github.com/lodyai/lody/pull/${input.prNumber}`,
      prompt: `Review PR #${input.prNumber} at ${input.headSha}.`,
    });
    return { sessionId: created.sessionId };
  });

  // @ts-expect-error Browser DOM globals are unavailable inside machine plugins.
  void window;

  // @ts-expect-error Tool handler return type must satisfy the tool output schema.
  machine.tool(runSuiteTool, () => ({ wrongField: true }));

  return () => {};
});
