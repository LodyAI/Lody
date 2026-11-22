import { vi } from 'vitest';

export type FakeMetaSub = {
  status: 'joined';
  firstSyncedWithRemote: Promise<void>;
  onStatusChange: (listener: (status: 'joined') => void) => () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

export const createMetaSub = (firstSyncedWithRemote: Promise<void>): FakeMetaSub => {
  const bindings = new Map<string, unknown>();
  return {
    status: 'joined',
    firstSyncedWithRemote,
    onStatusChange: vi.fn(() => vi.fn()),
    unsubscribe: vi.fn(),
    // Per-transport stable bindings (loro-repo >=0.19); the runtime selects a
    // plane instead of reading the aggregate on dual-homed rooms.
    subscription: vi.fn((transportId: string) => {
      let binding = bindings.get(transportId);
      if (!binding) {
        binding = {
          transportId,
          status: 'joined',
          firstSyncedWithRemote,
          onStatusChange: vi.fn(() => vi.fn()),
          waitUntilSynced: vi.fn(async () => {}),
          rejoin: vi.fn(async () => {}),
        };
        bindings.set(transportId, binding);
      }
      return binding;
    }),
  };
};

export const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};
