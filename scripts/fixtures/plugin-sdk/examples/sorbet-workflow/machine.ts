import { defineMachinePlugin } from "@lody/plugin-sdk/machine";
import { workflowStatusQuery } from "./shared";

const verifiedBySession = new Map<
  string,
  { lastVerifiedTurnId: string; verifierSessionId: string }
>();

export default defineMachinePlugin((machine) => {
  machine.query(workflowStatusQuery, (ctx) => {
    const state = verifiedBySession.get(ctx.target.sessionId);
    return {
      lastVerifiedTurnId: state?.lastVerifiedTurnId ?? null,
      verifierSessionId: state?.verifierSessionId ?? null,
    };
  });

  machine.events.on("session.turn.completed", async (ctx, event) => {
    if (event.stopReason !== "end_turn") return;
    if (ctx.config.autoVerify === false) return;

    const rawMeta = await ctx.lody.readSnapshot({
      kind: "session-meta",
      session: event.session,
    });
    if (rawMeta.doc.agentRoleId !== "plugin:sorbet-workflow:sorbet-architect") {
      return;
    }

    const target = event.project ?? event.machine;
    const verifier = await ctx.lody.sessions.create(target, {
      requestId: `verify-${event.session.sessionId}-${event.turnId}`,
      businessKey: `verify/${event.session.sessionId}`,
      roleId: "plugin:sorbet-workflow:sorbet-architect",
      providerId: "plugin:sorbet-workflow:sorbet-acp",
      parentSession: event.session,
      skillIds: ["sorbet-verifier"],
      prompt: `Verify completed Architect turn ${event.turnId}.`,
    });

    verifiedBySession.set(event.session.sessionId, {
      lastVerifiedTurnId: event.turnId,
      verifierSessionId: verifier.sessionId,
    });
    ctx.invalidate(workflowStatusQuery, event.session);
  });
});
