import type { MemoryProviderResponse } from '@lody/shared';
import type { useMemoryProvider } from '@/hooks/use-memory-provider';

type MemoryProviderState = ReturnType<typeof useMemoryProvider>;

export const memoryReply = (
  overrides: Partial<MemoryProviderResponse> = {}
): MemoryProviderResponse => ({
  type: 'machine/memory',
  status: 'ready',
  memories: [],
  ...overrides,
});

/** A provider hook that answers every request with one reply, unless a story says otherwise. */
export const memoryProviderStoryState = (
  result: MemoryProviderResponse,
  overrides: Partial<MemoryProviderState> = {}
): MemoryProviderState => ({
  result,
  busy: false,
  refresh: async () => result,
  create: async () => result,
  update: async () => result,
  connect: async () => result,
  disconnect: async () => result,
  connectPoll: async () => result,
  signIn: async () => result,
  signInPoll: async () => result,
  install: async () => result,
  installPoll: async () => result,
  ...overrides,
});
