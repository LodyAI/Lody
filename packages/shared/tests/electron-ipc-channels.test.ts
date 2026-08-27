import { describe, expect, it } from 'vitest';
import {
  IPC_PUSH_CHANNELS,
  IPC_SEND_CHANNELS,
  isIpcPushChannel,
  isIpcSendChannel,
} from '../src/electron-ipc-channels';

describe('IPC push/send channel allowlists', () => {
  it('types push and send maps onto the new group.method names', () => {
    expect(IPC_PUSH_CHANNELS.sessionControlResponse).toBe('sessionControl.response');
    expect(IPC_PUSH_CHANNELS.terminalEvent).toBe('terminal.event');
    expect(IPC_SEND_CHANNELS.terminalInput).toBe('terminal.input');
    expect(isIpcPushChannel('sessionControl.response')).toBe(true);
    expect(isIpcSendChannel('loro.send')).toBe(true);
    expect(isIpcPushChannel('lodySessionControl:response')).toBe(false);
  });
});
