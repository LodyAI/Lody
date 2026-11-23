import { defineMutation, defineQuery, lodyQueries } from "@lody/plugin-sdk";
import { defineMachinePlugin } from "@lody/plugin-sdk/machine";
import { z } from "zod";
import { runSuiteTool } from "./examples/test-report/shared";

// @ts-expect-error Machine plugins cannot import browser client hooks or registries.
import("@lody/plugin-sdk/client");

const machineDigestQuery = defineQuery("machine", "daemon.digest", {
  input: z.object({ limit: z.number().int().default(10) }),
  output: z.object({ count: z.number().int() }),
});

const sessionMonitorQuery = defineQuery("session", "monitor.state", {
  input: z.object({}),
  output: z.object({ activeStep: z.string().nullable() }),
});

const recoverReviewMutation = defineMutation("project", "review.ensure", {
  input: z.object({
    requestId: z.string().uuid(),
    prNumber: z.number().int(),
    headSha: z.string(),
  }),
  output: z.object({ sessionId: z.string() }),
});

export const machineContractChecks = defineMachinePlugin((machine) => {
  // @ts-expect-error Pre-Turn prompt injection (`beforeSessionTurn`) was removed to preserve E2EE prompt integrity.
  void machine.beforeSessionTurn;

  machine.query(machineDigestQuery, (ctx, input) => {
    const limit: number = input.limit;
    const machineId: string = ctx.target.machineId;
    const dataDir: string = ctx.dataDir;
    void machineId;
    void dataDir;
    // @ts-expect-error Machine-scoped context does not expose projectId.
    void ctx.target.projectId;
    // @ts-expect-error Separate `sessionDataDir` was collapsed into `ctx.dataDir` keyed by immutable IDs.
    void ctx.sessionDataDir;
    // @ts-expect-error Duplicate `ctx.env` was unified into `ctx.config`.
    void ctx.env;
    return { count: limit };
  });

  machine.query(sessionMonitorQuery, async (ctx) => {
    // @ts-expect-error Machine daemon port never exposes client-only `respondInteraction` (requires physical user gesture).
    void ctx.lody.sessions.respondInteraction;
    const detail = await ctx.lody.read(ctx.target, lodyQueries.sessionDetail, {
      recentTurnLimit: 3,
    });
    return { activeStep: detail.recentTurns[0]?.previewText ?? null };
  });

  machine.mutation(recoverReviewMutation, async (ctx, input) => {
    const key = `review/${input.prNumber}/${input.headSha}`;
    ctx.invalidate(sessionMonitorQuery);
    // Replaying the original request also recovers an archived Session; an active-only
    // catalog lookup must not decide whether this operation has already been accepted.
    const created = await ctx.lody.sessions.create(ctx.target, {
      requestId: input.requestId,
      businessKey: key,
      roleId: "role_reviewer",
      pullRequestUrl: `https://github.com/lodyai/lody/pull/${input.prNumber}`,
      prompt: `Review PR #${input.prNumber} at ${input.headSha}.`,
    });
    return { sessionId: created.sessionId };
  });

  // @ts-expect-error Browser DOM globals are unavailable inside machine plugins.
  void window;

  // @ts-expect-error Tool handler return type must satisfy the tool output schema.
  machine.tool(runSuiteTool, () => ({ wrongField: true }));

  return async () => {};
});

export const machineWorkflowEventChecks = defineMachinePlugin((machine) => {
  machine.events.on("session.tool.completed", async (ctx, event) => {
    const completedTool: string = event.toolCall.toolName;
    void completedTool;
    const raw = await ctx.lody.readSnapshot({
      kind: "session-meta",
      session: event.session,
    });
    // @ts-expect-error Machine raw document snapshots are deeply readonly.
    raw.doc.tampered = "nope";
  });
});
