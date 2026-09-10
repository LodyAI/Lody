import { describe, expect, it, vi } from 'vitest';
import type { MachineId, WorkspaceId } from '@lody/shared';
import {
  type EphemeralRoomStartArgs,
  type EphemeralRoomTransportLike,
} from '../src/providers/ephemeral-room-transport';
import { WorkspaceMachineMonitorTransport } from '../src/providers/workspace-machine-monitor-transport';

const WORKSPACE_ID = 'workspace-1' as WorkspaceId;
const MACHINE_ID = 'machine-1' as MachineId;

class TestWorkspaceMachineMonitorTransport extends WorkspaceMachineMonitorTransport {
  readonly transports: Array<{ close: ReturnType<typeof vi.fn> }> = [];

  protected override createTransport(): EphemeralRoomTransportLike {
    const close = vi.fn(async () => {});
    this.transports.push({ close });
    return {
      join: () =>
        Promise.resolve({
          ok: true,
          value: { unsubscribe: () => {} },
        } as Awaited<ReturnType<EphemeralRoomTransportLike['join']>>),
      close,
    };
  }
}

const START_ARGS: EphemeralRoomStartArgs = {
  baseUrl: 'https://streams.example.test',
  auth: async () => 'token',
};

describe('WorkspaceMachineMonitorTransport', () => {
  it('joins only while at least one machine snapshot is observed', async () => {
    const transport = new TestWorkspaceMachineMonitorTransport({ workspaceId: WORKSPACE_ID });

    transport.start(START_ARGS);
    expect(transport.transports).toHaveLength(0);

    const unsubscribe = transport.subscribeMachine(MACHINE_ID, vi.fn());
    expect(transport.transports).toHaveLength(1);

    const secondListenerUnsubscribe = transport.subscribeMachine(MACHINE_ID, vi.fn());
    expect(transport.transports).toHaveLength(1);
    unsubscribe();
    await Promise.resolve();
    expect(transport.transports[0]?.close).not.toHaveBeenCalled();

    secondListenerUnsubscribe();
    await Promise.resolve();
    expect(transport.transports[0]?.close).toHaveBeenCalledOnce();

    const secondUnsubscribe = transport.subscribeMachine(MACHINE_ID, vi.fn());
    expect(transport.transports).toHaveLength(2);
    secondUnsubscribe();
    await transport.stop();
  });
});
