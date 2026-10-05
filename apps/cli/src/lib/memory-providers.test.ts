import { describe, expect, it } from 'vitest';
import { MemoryCreateInputSchema } from '@lody/shared';
import {
  createNowledgeMemoryProvider,
  handleMemoryProviderRequest,
  memoryEnvironment,
} from './memory-providers';

describe('Nowledge memory provider', () => {
  it('distinguishes an absent executable, inactive service, and malformed output', async () => {
    for (const [result, status] of [
      [{ stdout: '', code: 'ENOENT' }, 'not_installed'],
      [{ stdout: '{"status":"starting"}' }, 'not_running'],
      [{ stdout: '', code: 1 }, 'not_running'],
      [{ stdout: 'invalid' }, 'error'],
    ] as const) {
      const provider = createNowledgeMemoryProvider(async () => result);
      expect(
        await handleMemoryProviderRequest({ action: 'list', providerId: provider.id }, [provider])
      ).toEqual({ type: 'machine/memory', status, memories: [] });
    }
  });
  it('enrolls a literal identity and returns the updated provider catalog', async () => {
    const profiles: {
      id: string;
      displayName: string;
      sourceApp: string;
      defaultSpaceId: string;
    }[] = [];
    const provider = createNowledgeMemoryProvider(async (args) => {
      if (args[0] === 'status') return { stdout: '{"status":"ok"}' };
      if (args[1] === 'enroll') {
        // Model the CLI argv boundary: metacharacters must remain one literal value.
        const name = args[args.indexOf('--name') + 1];
        profiles.push({
          id: args[2] ?? '',
          displayName: name ?? '',
          sourceApp: args[args.indexOf('--source-app') + 1] ?? '',
          defaultSpaceId: args.includes('--default-space')
            ? (args[args.indexOf('--default-space') + 1] ?? '')
            : '',
        });
        return { stdout: '{}' };
      }
      return { stdout: JSON.stringify({ agentProfiles: profiles }) };
    });
    const result = await handleMemoryProviderRequest(
      {
        action: 'create',
        providerId: provider.id,
        input: { id: 'reviewer', name: 'Review $(literal); name' },
      },
      [provider]
    );
    expect(result).toEqual({
      type: 'machine/memory',
      status: 'ready',
      memories: [
        {
          id: 'reviewer',
          name: 'Review $(literal); name',
          description: undefined,
        },
      ],
    });
    expect(profiles[0]).toMatchObject({ sourceApp: 'lody.ai', defaultSpaceId: '' });
    expect(memoryEnvironment({ providerId: provider.id, memoryId: 'reviewer' })).toEqual({
      NMEM_AGENT_ID: 'reviewer',
    });
  });
  it('requires a non-blank name and normalizes surrounding whitespace', () => {
    for (const name of [undefined, '', '   ']) {
      expect(MemoryCreateInputSchema.safeParse({ id: 'reviewer', name }).success).toBe(false);
    }
    expect(MemoryCreateInputSchema.parse({ id: 'reviewer', name: ' Reviewer ' }).name).toBe(
      'Reviewer'
    );
  });
  it('does not present failed or malformed catalogs as an empty success', async () => {
    const provider = createNowledgeMemoryProvider(async (args) =>
      args[0] === 'status'
        ? { stdout: '{"status":"ok"}' }
        : { stdout: '{"agentProfiles":[{"name":"missing id"}]}' }
    );
    expect(
      (await handleMemoryProviderRequest({ action: 'list', providerId: provider.id }, [provider]))
        .status
    ).toBe('error');
    expect(() => memoryEnvironment({ providerId: 'missing', memoryId: 'reviewer' })).toThrow(
      'Unsupported memory provider'
    );
  });
});
