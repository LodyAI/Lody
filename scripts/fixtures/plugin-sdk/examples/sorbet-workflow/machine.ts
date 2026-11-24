import { defineMachinePlugin } from '@lody/plugin-sdk/machine';
import { workflowStatusQuery } from './shared';
export default defineMachinePlugin((machine) => {
  machine.query(workflowStatusQuery, async (ctx) =>
    workflowStatusQuery.output.parse(
      (await ctx.storage.get(`latest:${ctx.target.sessionId}`)) ?? {
        lastVerifiedTurnId: null,
        verifierSessionId: null,
      }
    )
  );
  machine.events.on(
    'session.turn.completed',
    async (ctx, event) => {
      if (!event.project || event.stopReason !== 'end_turn' || ctx.config.autoVerify === false)
        return;
      if (event.agentRoleId !== 'plugin:sorbet-workflow:sorbet-architect') return;
      const { session, turnId, userTurnId } = event;
      const verifier = await ctx.lody.sessions.create(event.project, {
        requestId: `verify-${session.sessionId}-${turnId}`,
        businessKey: `verify/${session.sessionId}/${turnId}`,
        roleId: 'plugin:sorbet-workflow:sorbet-verifier',
        providerId: 'plugin:sorbet-workflow:sorbet-acp',
        parentSession: session,
        ...(userTurnId ? { originTurn: { session, userTurnId } } : {}),
        skillIds: ['sorbet-verifier'],
        prompt: `Verify completed Architect turn ${turnId}.`,
      });
      await ctx.storage.set(`latest:${session.sessionId}`, {
        lastVerifiedTurnId: turnId,
        verifierSessionId: verifier.sessionId,
      });
      ctx.invalidate(workflowStatusQuery, session);
    },
    { resumeFromCursor: true }
  );
});
