import { ndJsonStream, type ClientSideConnection, type Stream } from '@agentclientprotocol/sdk';
import type { AgentConfigCliType } from '@lody/shared';

/** The existing host control contract; Pi implements it in-process, without ACP on the wire. */
export type AgentConnection = Pick<
  ClientSideConnection,
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'resumeSession'
  | 'unstable_forkSession'
  | 'prompt'
  | 'cancel'
  | 'closeSession'
  | 'setSessionConfigOption'
  | 'setSessionMode'
  | 'request'
>;
export type PiStream = {
  protocol: 'pi';
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
};
export type AgentStream = Stream | PiStream;

export function createAgentStream(
  writable: WritableStream<Uint8Array>,
  readable: ReadableStream<Uint8Array>,
  config?: { cliType: AgentConfigCliType; agentType: string }
): AgentStream {
  return config?.cliType === 'builtin' && config.agentType === 'pi'
    ? { protocol: 'pi', writable, readable }
    : ndJsonStream(writable, readable);
}
