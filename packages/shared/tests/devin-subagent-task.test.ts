import { describe, expect, it } from 'vitest';
import {
  getDevinSubagentContextId,
  parseDevinSubagentTaskMeta,
} from '../src/acp/devin-subagent-task';

// Shapes captured from `devin acp` 3000.10.21 with the client capability
// `_meta["cognition.ai/subagentSupport"]: true`; the protocol is private and
// undocumented, so these tests pin the observed wire contract.
describe('parseDevinSubagentTaskMeta', () => {
  it('maps a failed completion to failed status and surfaces the summary as error', () => {
    const parsed = parseDevinSubagentTaskMeta({
      'cognition.ai/subagent_completed': {
        agentId: '1514ced7',
        success: false,
        summary: 'Exploration aborted',
      },
    });
    expect(parsed).toMatchObject({
      status: 'failed',
      summary: 'Exploration aborted',
      error: 'Exploration aborted',
    });
  });
});

describe('getDevinSubagentContextId', () => {
  it('returns the owning subagent id for subagent-scoped updates', () => {
    expect(
      getDevinSubagentContextId({
        'cognition.ai/subagent_context': { parentAgentId: '1514ced7' },
      })
    ).toBe('1514ced7');
  });

  it('treats root-scoped and untagged updates as main-agent output', () => {
    expect(
      getDevinSubagentContextId({
        'cognition.ai/subagent_context': { parentAgentId: 'root' },
      })
    ).toBeNull();
    expect(getDevinSubagentContextId({})).toBeNull();
    expect(getDevinSubagentContextId(undefined)).toBeNull();
    expect(getDevinSubagentContextId({ 'cognition.ai/subagent_context': 'nope' })).toBeNull();
  });
});
