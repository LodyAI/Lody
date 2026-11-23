import { createWorkspaceStreamsTransport } from './workspace-streams-transport';
// A compile-time API contract, deliberately never executed or imported by product code.
export function workspaceTransportContentContract(options: Omit<Parameters<typeof createWorkspaceStreamsTransport>[0], 'content'>) {
  // @ts-expect-error Every transport owner must explicitly choose its content mode.
  createWorkspaceStreamsTransport(options);
}
