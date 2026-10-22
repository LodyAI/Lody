import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockedInboxExecution } from '@/orchestration/inbox/recovery';
import { createSessionInboxRecoveryCommand } from './session-inbox-recovery';

const platform = vi.hoisted(() => ({ make: vi.fn() }));
vi.mock('@/orchestration/platform/operator-recovery', () => ({
  makeInboxOperatorRecovery: platform.make,
}));

let records: BlockedInboxExecution[];
let inspectedOnly: boolean | undefined;
const baseArgs = ['--machine', 'machine', '--workspace', 'workspace'];
const run = (args: string[]) =>
  createSessionInboxRecoveryCommand().exitOverride().parseAsync(args, { from: 'user' });
const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string);
beforeEach(() => {
  vi.stubEnv('LODY_SESSION_ID', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  records = [
    {
      scope: { workspaceId: 'workspace', sessionId: '-session', userId: 'owner' },
      executionId: 'execution',
      reason: 'missing_identity',
      resources: [],
      snapshotToken: 'a'.repeat(64),
    },
  ];
  inspectedOnly = undefined;
  platform.make.mockImplementation((_machine, _workspace, options) => {
    inspectedOnly = options.inspectOnly;
    return Effect.succeed({
      blocked: Effect.sync(() => records),
      exclusive: (work: Effect.Effect<unknown>) => work,
      knownResourcesGone: () => Effect.succeed(true),
      confirm: () =>
        Effect.sync(() => {
          records = [];
          return true;
        }),
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('offline Inbox recovery command', () => {
  it('inspects without clearing ownership and offers a separate snapshot-bound recovery command', async () => {
    await run([...baseArgs, '--', '-session']);
    expect(inspectedOnly).toBe(true);
    expect(records).toHaveLength(1);
    expect(output()).toMatchObject({
      machineId: 'machine',
      workspaceId: 'workspace',
      sessionId: '-session',
      blocked: true,
    });
    expect(output().records[0].recoveryCommand).toContain("--execution 'execution' --snapshot '");
    expect(output().guidance.join(' ')).toContain('including unrecorded descendants');
    expect(output().records[0].recoveryCommand.endsWith("-- '-session'")).toBe(true);
  });
  it('requires exact snapshot and explicit attestation before clearing an execution', async () => {
    await expect(
      run([
        ...baseArgs,
        '--execution',
        'execution',
        '--confirm-resources-released',
        '--',
        '-session',
      ])
    ).rejects.toThrow('exact --snapshot');
    await expect(
      run([...baseArgs, '--execution', 'execution', '--snapshot', 'a'.repeat(64), '--', '-session'])
    ).rejects.toThrow('confirm-resources-released');
    expect(records).toHaveLength(1);
    await run([
      ...baseArgs,
      '--execution',
      'execution',
      '--snapshot',
      'a'.repeat(64),
      '--confirm-resources-released',
      '--',
      '-session',
    ]);
    expect(inspectedOnly).toBe(false);
    expect(records).toEqual([]);
    expect(output()).toMatchObject({ recovered: true, executionId: 'execution', paused: true });
    expect(output().nextAction).toContain('Agent-chat');
  });
  it('gives a missing execution its own token path, never a fake execution ID', async () => {
    records = records.map((record) => ({
      ...record,
      executionId: null,
      reason: 'missing_active_execution',
    }));
    await run([...baseArgs, '--', '-session']);
    expect(output().records[0].recoveryCommand).toContain('--orphan');
    expect(output().records[0].recoveryCommand).not.toContain('--execution');
    await expect(
      run([...baseArgs, '--orphan', 'stale', '--confirm-resources-released', '--', '-session'])
    ).rejects.toThrow('snapshot changed');
    expect(records).toHaveLength(1);
    await run([
      ...baseArgs,
      '--orphan',
      'a'.repeat(64),
      '--confirm-resources-released',
      '--',
      '-session',
    ]);
    expect(output()).toMatchObject({ recovered: true, executionId: null, paused: true });
    expect(records).toEqual([]);
  });
  it('rejects ambiguous recovery options and Agent-session execution', async () => {
    await expect(
      run([...baseArgs, '--execution', 'execution', '--orphan', 'token', '--', '-session'])
    ).rejects.toThrow('not both');
    vi.stubEnv('LODY_SESSION_ID', 'synthetic-agent');
    await expect(run([...baseArgs, '--', '-session'])).rejects.toThrow('outside an Agent session');
    expect(records).toHaveLength(1);
  });
});
