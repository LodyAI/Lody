import type { MessageContent } from '@lody/shared';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

/**
 * WHERE EACH AGENT PUTS ITS PLAN.
 *
 * The bundled adapters disagree, and the disagreement is invisible from the
 * rendered turn — so this module is the one place that knows, and every agent's
 * plan reaches the SAME panel from here.
 *
 *   Claude (`ExitPlanMode`, `acp-extension-claude/src/tools.ts`)
 *     kind `switch_mode`, plan as a `content` text block.
 *   Kimi (`ExitPlanMode`, `acp-extension-kimi` `convert.ts` `plan_review`)
 *     plan as a `content` text block, optionally prefixed `Plan saved to: …`.
 *   Codex (`CodexAcpServer.requestPlanImplementationPermission`)
 *     kind `switch_mode`, plan in `rawInput.plan`, which the card never renders
 *     — the readable copy is a SEPARATE `proposed_plan` item.
 *
 * So `content` and `rawInput.plan` are both real carriers and neither is
 * universal. A new adapter that picks either one renders correctly without a
 * change here; one that invents a third carrier adds a case to
 * `resolvePlanExitMarkdown` and nothing else.
 */

/**
 * Plan text carried by the approval card itself, if any.
 *
 * The FIRST text block, not all of them joined: Kimi builds its approval card as
 * `[plan, "Requesting approval to <action>"]`
 * (`acp-adapter/src/approval.ts` `buildPermissionToolCallUpdate`), so joining
 * would paste its action summary into the plan. Claude sends the plan as its
 * only block, and Codex sends none, so the first block is the plan for every
 * adapter that carries one.
 */
export const resolvePlanExitMarkdown = (toolCall: ToolCallMessage): string | null => {
  const fromContent = (toolCall.content ?? []).find(
    (block) =>
      block.type === 'content' && block.content.type === 'text' && block.content.text.trim()
  );
  if (fromContent?.type === 'content' && fromContent.content.type === 'text') {
    return fromContent.content.text.trim();
  }

  // Codex's carrier. Read defensively: `rawInput` is agent-supplied.
  const rawPlan = (toolCall.rawInput as { plan?: unknown } | undefined)?.plan;
  if (typeof rawPlan === 'string' && rawPlan.trim()) return rawPlan.trim();

  return null;
};

/**
 * Does the turn already render the plan as its own `proposed_plan` row?
 *
 * When it does (Codex), the approval card must NOT render its own copy or the
 * plan prints twice — `rawInput.plan` and the `proposed_plan` item are the same
 * text arriving by two routes.
 */
export const hasSeparatePlanItem = (items: readonly MessageContent[]): boolean =>
  items.some((item) => item.type === 'proposed_plan' && item.markdown.trim().length > 0);

/**
 * Is this turn's plan approval still waiting on the reader? Keyed on the ACP
 * tool kind and an ABSENT outcome — a CANCELLED request is answered (withdrawn),
 * not pending, so it must not hold the plan open.
 *
 * Drives the plan panel's default: a plan you are being asked to approve opens
 * in full, a plan you already decided on clamps.
 */
export const hasUnansweredPlanApproval = (items: readonly MessageContent[]): boolean =>
  items.some(
    (item) =>
      item.type === 'tool_call' &&
      item.kind === 'switch_mode' &&
      Boolean(item.permissionRequest) &&
      !item.permissionRequest?.outcome
  );
