import { describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';
import {
  hasSeparatePlanItem,
  hasUnansweredPlanApproval,
  resolvePlanExitMarkdown,
} from '../src/components/ai-gui/plan-surface';

const toolCall = (overrides: Record<string, unknown>): MessageContent =>
  ({
    type: 'tool_call',
    toolCallId: 't',
    kind: 'switch_mode',
    status: 'completed',
    ...overrides,
  }) as MessageContent;

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

  it('prefers the rendered content block over rawInput when an agent sends both', () => {
    expect(
      resolvePlanExitMarkdown(
        toolCall({
          content: [{ type: 'content', content: { type: 'text', text: 'shown' } }],
          rawInput: { plan: 'raw' },
        })
      )
    ).toBe('shown');
  });

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

  it('returns null when the card carries no plan, and ignores non-string rawInput', () => {
    expect(resolvePlanExitMarkdown(toolCall({}))).toBeNull();
    expect(resolvePlanExitMarkdown(toolCall({ content: [] }))).toBeNull();
    expect(resolvePlanExitMarkdown(toolCall({ rawInput: { plan: { nested: true } } }))).toBeNull();
    expect(resolvePlanExitMarkdown(toolCall({ rawInput: { plan: '   ' } }))).toBeNull();
  });
});

describe('hasSeparatePlanItem', () => {
  const planItem = (markdown: string): MessageContent =>
    ({
      type: 'proposed_plan',
      turnId: 't',
      markdown,
      status: 'completed',
      isLatest: true,
    }) as MessageContent;

  it('is true when the turn renders its own plan row (Codex)', () => {
    expect(hasSeparatePlanItem([planItem('# Plan')])).toBe(true);
  });

  it('is false without one, so the card renders its own copy (Claude, Kimi)', () => {
    expect(hasSeparatePlanItem([toolCall({})])).toBe(false);
  });

  it('ignores an empty plan row, which renders nothing to duplicate', () => {
    expect(hasSeparatePlanItem([planItem('   ')])).toBe(false);
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

  it('ignores tool calls that are not a plan exit', () => {
    const edit = {
      type: 'tool_call',
      toolCallId: 'edit-1',
      kind: 'edit',
      status: 'pending',
      permissionRequest: request(),
    } as MessageContent;
    expect(hasUnansweredPlanApproval([edit])).toBe(false);
    expect(hasUnansweredPlanApproval([{ type: 'text', text: 'hi' } as MessageContent])).toBe(false);
  });
});
