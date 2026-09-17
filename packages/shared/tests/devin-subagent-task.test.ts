import { describe, expect, it } from 'vitest';
import {
  getDevinSubagentContextId,
  hasOtherDevinSubagentMeta,
  parseDevinSubagentTaskMeta,
} from '../src/acp/devin-subagent-task';

// Shapes captured from `devin acp` 3000.10.21 with the client capability
// `_meta["cognition.ai/subagentSupport"]: true`; the protocol is private and
// undocumented, so these tests pin the observed wire contract.
describe('parseDevinSubagentTaskMeta', () => {
  it('maps subagent_started to an in-progress task', () => {
    const parsed = parseDevinSubagentTaskMeta({
      'cognition.ai/subagent_started': {
        agentId: '1514ced7',
        title: 'List files in current directory',
        task: 'List the files and report their names.',
        profile: 'Explore',
        depth: 1,
        isBackground: true,
        model: 'SWE-2 High',
      },
    });
    expect(parsed).toEqual({
      taskId: '1514ced7',
      status: 'in_progress',
      taskKind: 'subagent',
      event: 'task_started',
      description: 'List files in current directory',
      subagentType: 'Explore',
      modelId: 'SWE-2 High',
      isBackgrounded: true,
    });
  });

  it('falls back to the task text when title is absent', () => {
    const parsed = parseDevinSubagentTaskMeta({
      'cognition.ai/subagent_started': { agentId: 'a1', task: 'Do the thing' },
    });
    expect(parsed).toMatchObject({ taskId: 'a1', description: 'Do the thing' });
  });

  it('maps subagent_completed to a completed task with summary', () => {
    const parsed = parseDevinSubagentTaskMeta({
      'cognition.ai/subagent_completed': {
        agentId: '1514ced7',
        success: true,
        summary: 'Found one file: hello.txt',
        depth: 1,
      },
    });
    expect(parsed).toEqual({
      taskId: '1514ced7',
      status: 'completed',
      taskKind: 'subagent',
      event: 'task_notification',
      summary: 'Found one file: hello.txt',
    });
  });

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

  it('returns null for absent or malformed lifecycle markers', () => {
    expect(parseDevinSubagentTaskMeta(undefined)).toBeNull();
    expect(parseDevinSubagentTaskMeta({ 'cognition.ai/turn_stats': {} })).toBeNull();
    expect(
      parseDevinSubagentTaskMeta({ 'cognition.ai/subagent_started': { title: 'no id' } })
    ).toBeNull();
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

describe('hasOtherDevinSubagentMeta', () => {
  it('detects lifecycle and unrecognized subagent payloads but not the context tag', () => {
    expect(
      hasOtherDevinSubagentMeta({
        'cognition.ai/subagent_context': { parentAgentId: 'a1' },
        'cognition.ai/subagent_started': { agentId: 'a2' },
      })
    ).toBe(true);
    expect(
      hasOtherDevinSubagentMeta({ 'cognition.ai/subagent_context': { parentAgentId: 'a1' } })
    ).toBe(false);
    expect(hasOtherDevinSubagentMeta({ 'cognition.ai/turn_stats': {} })).toBe(false);
    expect(hasOtherDevinSubagentMeta(undefined)).toBe(false);
  });
});
