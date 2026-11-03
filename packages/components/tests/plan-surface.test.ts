import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';
import {
  hasUnansweredPlanApproval,
  resolvePlanExitMarkdown,
} from '../src/components/ai-gui/plan-surface';

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

const toolCall = (overrides: Partial<ToolCallMessage>): ToolCallMessage =>
  ({
    type: 'tool_call',
    toolCallId: 't',
    kind: 'switch_mode',
    status: 'completed',
    ...overrides,
  }) as ToolCallMessage;

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'r',
  options: [{ optionId: 'allow', name: 'Yes', kind: 'allow_once' }],
  ...overrides,
});

/**
 * The bundled adapters put the plan in different places. These are the shapes
 * they actually emit, so a regression here means one agent's plan silently
 * stops rendering (or renders twice).
 */
describe('resolvePlanExitMarkdown', () => {
  it("reads Claude's and Kimi's card-carried content block", () => {
    expect(
      resolvePlanExitMarkdown(
        toolCall({
          content: [{ type: 'content', content: { type: 'text', text: '# Plan\n1. Go' } }],
        })
      )
    ).toBe('# Plan\n1. Go');
  });

  it("reads Codex's rawInput carrier", () => {
    expect(resolvePlanExitMarkdown(toolCall({ rawInput: { plan: '# Codex plan' } }))).toBe(
      '# Codex plan'
    );
  });

  it.each([
    { status: 'failed' as const, result: "The user doesn't want to proceed with this tool use." },
    { status: 'completed' as const, result: 'User has approved your plan.' },
  ])(
    'keeps the submitted plan after a $status result replaces card content',
    ({ status, result }) => {
      const markdown = '# Plan\n1. Keep the tests.\n2. Update the parser.';
      const pending = toolCall({
        status: 'pending',
        rawInput: { plan: markdown },
        content: [{ type: 'content', content: { type: 'text', text: markdown } }],
      });
      expect(resolvePlanExitMarkdown(pending)).toBe(markdown);

      // ACP replaces content but retains rawInput when the result omits it.
      const settled = toolCall({
        ...pending,
        status,
        content: [{ type: 'content', content: { type: 'text', text: result } }],
        rawOutput: result,
      });
      expect(resolvePlanExitMarkdown(settled)).toBe(markdown);
      // A hydrated historical card has no component-local copy of the plan.
      expect(resolvePlanExitMarkdown(JSON.parse(JSON.stringify(settled)))).toBe(markdown);
      expect(resolvePlanExitMarkdown({ ...settled, content: [] })).toBe(markdown);
    }
  );

  it("takes only the first block, so Kimi's action summary stays out of the plan", () => {
    // Kimi builds `[plan, "Requesting approval to <action>"]`; joining pasted
    // the summary into the plan body.
    expect(
      resolvePlanExitMarkdown(
        toolCall({
          content: [
            { type: 'content', content: { type: 'text', text: 'Plan saved to: /p\n\n# Plan' } },
            { type: 'content', content: { type: 'text', text: 'Requesting approval to run' } },
          ],
        })
      )
    ).toBe('Plan saved to: /p\n\n# Plan');
  });
});

describe('hasUnansweredPlanApproval', () => {
  const planExit = (permissionRequest: unknown): MessageContent =>
    ({
      type: 'tool_call',
      toolCallId: 'plan-exit',
      kind: 'switch_mode',
      status: 'pending',
      permissionRequest,
    }) as MessageContent;

  it('holds the plan open while the approval is unanswered', () => {
    expect(hasUnansweredPlanApproval([planExit(request())])).toBe(true);
  });

  it('lets the plan clamp once the reader has answered', () => {
    expect(
      hasUnansweredPlanApproval([
        planExit(request({ outcome: { outcome: 'selected', optionId: 'allow' } })),
      ])
    ).toBe(false);
  });

  it('treats a withdrawn request as answered, not pending', () => {
    // A cancelled request has nothing left to decide, so it must not pin the
    // plan open for the rest of the session.
    expect(
      hasUnansweredPlanApproval([planExit(request({ outcome: { outcome: 'cancelled' } }))])
    ).toBe(false);
  });
});
