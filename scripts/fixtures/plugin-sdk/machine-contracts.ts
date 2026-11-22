import { defineMutation, defineObservation, defineQuery, lodyQueries } from '@lody/plugin-sdk';
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

const queueDepthObservation = defineObservation('project', 'queue.depth', {
  input: z.object({}),
  output: z.object({ ready: z.boolean() }),
});

const recoverReviewMutation = defineMutation('project', 'review.ensure', {
  input: z.object({
    requestId: z.string().uuid(),
    prNumber: z.number().int(),
    headSha: z.string(),
  }),
  output: z.object({ sessionId: z.string() }),
});

export const machineContractChecks = defineMachinePlugin((machine) => {
  machine.query(machineDigestQuery, (ctx, input) => {
    const limit: number = input.limit;
    const machineId: string = ctx.target.machineId;
    const absentSessionDir: undefined = ctx.sessionDataDir;
    void machineId;
    void absentSessionDir;
    // @ts-expect-error Machine-scoped context does not expose projectId.
    void ctx.target.projectId;
    return { count: limit };
  });

  machine.query(sessionMonitorQuery, async (ctx) => {
    const sessionDir: string = ctx.sessionDataDir;
    void sessionDir;
    const detail = await ctx.host.read(ctx.target, lodyQueries.sessionDetail, {
      recentTurnLimit: 3,
    });
    return { activeStep: detail.recentTurns[0]?.previewText ?? null };
  });

  machine.observation(queueDepthObservation, async () => ({
    value: { ready: true },
    observedAt: Date.now(),
    revision: 'depth-v1',
  }));

  machine.onSessionEvent((ctx, event) => {
    if (event.kind === 'turn.completed') {
      const rootId: string | undefined = event.openedByRootSessionId;
      void rootId;
      ctx.invalidate(sessionMonitorQuery, ctx.target);
    }
  });

  machine.mutation(recoverReviewMutation, async (ctx, input) => {
    const key = `review/${input.prNumber}/${input.headSha}`;
    // Push-assist wakeup hint for waiting Sessions watching this project observation.
    ctx.invalidate(queueDepthObservation, ctx.target);
    // Replaying the original request also recovers an archived Session; an active-only
    // catalog lookup must not decide whether this operation has already been accepted.
    const created = await ctx.host.sessions.create(ctx.target, {
      requestId: input.requestId,
      businessKey: key,
      businessKeyScope: 'project',
      pluginRoleId: 'reviewer',
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
