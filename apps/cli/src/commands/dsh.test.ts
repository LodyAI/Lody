import { describe, expect, it } from 'vitest';
import { createDshCommand, selectDshProvider } from './dsh';

const providers = [
  { id: 'local-dsh', name: 'DeepSeek' },
  { id: 'other-dsh', name: 'Other' },
];

describe('lody dsh plugin', () => {
  it('extracts the Provider selector and preserves native package arguments and their order', async () => {
    const received: unknown[] = [];
    const command = createDshCommand(async (args, configId) => {
      received.push({ args, configId });
    });
    await command.parseAsync(
      ['plugin', 'add', 'github:owner/repo#tag', '--agent-config', 'local-dsh', '--save-exact'],
      { from: 'user' }
    );
    expect(received).toEqual([
      { args: ['add', 'github:owner/repo#tag', '--save-exact'], configId: 'local-dsh' },
    ]);
  });

  it('selects only an explicitly listed local DSH Provider, never an unknown id', async () => {
    expect(
      await selectDshProvider(providers, 'other-dsh', false, async () => {
        throw new Error('Unexpected prompt');
      })
    ).toEqual(providers[1]);
    await expect(
      selectDshProvider(providers, 'remote-or-non-dsh', false, async () => '')
    ).rejects.toThrow('not found');
  });

  it('prompts without an id even with one Provider, and fails clearly without a TTY', async () => {
    expect(
      await selectDshProvider(
        providers.slice(0, 1),
        undefined,
        true,
        async (choices) => choices[0]!.id
      )
    ).toEqual(providers[0]);
    await expect(
      selectDshProvider(providers.slice(0, 1), undefined, true, async () => {
        throw new Error('User cancelled');
      })
    ).rejects.toThrow('User cancelled');
    await expect(selectDshProvider(providers, undefined, false, async () => '')).rejects.toThrow(
      '--agent-config'
    );
    await expect(selectDshProvider([], undefined, true, async () => '')).rejects.toThrow(
      'No local'
    );
    await expect(
      selectDshProvider(providers, undefined, true, async () => 'unknown')
    ).rejects.toThrow('not found');
  });

  it('rejects profile overrides instead of installing outside the selected Provider', async () => {
    const command = createDshCommand(async () => {
      throw new Error('Must not execute');
    });
    await expect(
      command.parseAsync(['plugin', 'add', './plugin', '--profile=other'], { from: 'user' })
    ).rejects.toThrow('profile');
  });
});
