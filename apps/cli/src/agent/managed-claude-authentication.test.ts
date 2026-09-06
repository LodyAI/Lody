import { execFile } from 'node:child_process';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveACPProcessLaunchAsync } from './setting';
import { prepareManagedClaudeAuthentication } from './managed-claude-authentication';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./setting', () => ({ resolveACPProcessLaunchAsync: vi.fn() }));

describe('managed Claude native authentication preflight', () => {
  const input = {
    agentType: 'claude',
    accountProfileId: 'managed-id',
    executable: '/claude',
    env: { CLAUDE_CONFIG_DIR: '/selected/home', LODY_ACCOUNT_PROFILE_ID: 'managed-id' },
  };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolveACPProcessLaunchAsync).mockResolvedValue({
      command: '/node',
      args: ['/adapter', '--lody-check-managed-settings'],
      env: { CLAUDE_CODE_EXECUTABLE: '/claude' },
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null) => void)(null);
      return {} as never;
    });
  });
  it('checks settings in a separate process using the selected profile home', async () => {
    await expect(prepareManagedClaudeAuthentication(input)).resolves.toBe('/selected/home');
    expect(resolveACPProcessLaunchAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOverrides: { claudeCodeExecutable: '/claude' },
        extraArgs: ['--lody-check-managed-settings'],
      })
    );
    expect(execFile).toHaveBeenCalledWith(
      '/node',
      ['/adapter', '--lody-check-managed-settings'],
      expect.objectContaining({
        cwd: '/selected/home',
        env: { ...input.env, CLAUDE_CODE_EXECUTABLE: '/claude' },
        timeout: 15_000,
      }),
      expect.any(Function)
    );
  });
  it.each([
    { agentType: 'codex' },
    { accountProfileId: undefined },
    { accountProfileId: 'system-default' },
  ])('preserves default and other provider behavior: %o', async (override) => {
    await expect(prepareManagedClaudeAuthentication({ ...input, ...override })).resolves.toBe(
      os.homedir()
    );
    expect(execFile).not.toHaveBeenCalled();
  });
  it('blocks native authentication on preflight failure without returning process output', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error) => void)(new Error('private settings output'));
      return {} as never;
    });
    await expect(prepareManagedClaudeAuthentication(input)).rejects.toThrow(
      'could not be verified'
    );
    await expect(prepareManagedClaudeAuthentication(input)).rejects.not.toThrow(
      'private settings output'
    );
  });
  it('does not launch when cancellation already occurred', async () => {
    const signal = AbortSignal.abort();
    await expect(prepareManagedClaudeAuthentication({ ...input, signal })).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });
  it('passes cancellation through to an in-flight preflight process', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const options = args[2] as { signal: AbortSignal };
      const callback = args.at(-1) as (error: Error) => void;
      options.signal.addEventListener('abort', () => callback(new Error('aborted')), {
        once: true,
      });
      started();
      return {} as never;
    });
    const result = prepareManagedClaudeAuthentication({ ...input, signal: controller.signal });
    await running;
    controller.abort();
    await expect(result).rejects.toThrow('could not be verified');
  });
  it('fails closed when the bounded preflight times out', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      expect(args[2]).toMatchObject({ timeout: 15_000 });
      (args.at(-1) as (error: Error) => void)(
        Object.assign(new Error('timeout'), { killed: true })
      );
      return {} as never;
    });
    await expect(prepareManagedClaudeAuthentication(input)).rejects.toThrow(
      'could not be verified'
    );
  });
});
