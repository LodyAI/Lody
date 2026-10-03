import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { simulatorViewerWebRtcScript } from './viewer-webrtc';
import { simulatorRtcChunks } from './webrtc-protocol';

function fixture(options: { failConfig?: boolean; local?: boolean; gathering?: boolean } = {}) {
  const channels: Record<string, any> = {};
  const fallback: any[] = [];
  let peer: any;
  let gatheringReady!: () => void;
  const gatheringListening = new Promise<void>((resolve) => {
    gatheringReady = resolve;
  });
  let peerCreated!: () => void;
  const creatingPeer = new Promise<void>((resolve) => {
    peerCreated = resolve;
  });
  let ready!: () => void;
  const configured = new Promise<void>((resolve) => {
    ready = resolve;
  });
  class Channel {
    bufferedAmount = 0;
    sent: string[] = [];
    send(value: string) {
      this.sent.push(value);
    }
  }
  class Peer extends EventTarget {
    iceGatheringState = options.gathering ? 'gathering' : 'complete';
    localDescription = { sdp: 'offer' };
    closed = false;
    constructor() {
      super();
      peer = this;
      peerCreated();
    }
    override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
      super.addEventListener(...args);
      if (args[0] === 'icecandidate') gatheringReady();
    }
    createDataChannel(label: string) {
      return (channels[label] = new Channel());
    }
    async createOffer() {
      return { sdp: 'offer' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {
      ready();
    }
    close() {
      this.closed = true;
    }
  }
  class Socket {
    binaryType = '';
    readyState = 0;
    closed = false;
    sent: string[] = [];
    constructor() {
      fallback.push(this);
      ready();
    }
    send(value: string) {
      this.sent.push(value);
    }
    close() {
      this.closed = true;
    }
  }
  const context = vm.createContext({
    preferWebRtc: !options.local,
    RTCPeerConnection: Peer,
    WebSocket: Socket,
    AbortController,
    URL,
    ArrayBuffer,
    Uint8Array,
    DataView,
    setTimeout,
    clearTimeout,
    location: { href: 'https://viewer.example/private/?token=synthetic' },
    fetch: async () => {
      if (options.failConfig) throw Error('Unavailable');
      return new Response(JSON.stringify({ iceServers: [], sdp: 'answer' }));
    },
  });
  vm.runInContext(simulatorViewerWebRtcScript, context);
  const socket = vm.runInContext(
    "createSimulatorSocket(new URL('wss://viewer.example/private/stream?codec=h264'))",
    context
  );
  const open = () => channels.control.onmessage({ data: JSON.stringify({ type: 'rtc-ready' }) });
  return {
    socket,
    channels,
    fallback,
    configured,
    creatingPeer,
    gatheringListening,
    open,
    peer: () => peer,
  };
}

describe('simulator viewer RTC transport', () => {
  it('uses WebSocket directly for local viewers', () => {
    const f = fixture({ local: true });
    expect(f.fallback).toEqual([f.socket]);
    expect(f.peer()).toBeUndefined();
    f.socket.close();
  });

  it('falls back on bootstrap failure and closes the fallback on hide', async () => {
    const f = fixture({ failConfig: true });
    await f.configured;
    expect(f.fallback).toHaveLength(1);
    f.socket.send('heartbeat');
    expect(f.fallback[0].sent).toEqual(['heartbeat']);
    f.socket.close();
    expect(f.fallback[0].closed).toBe(true);
  });

  it('reassembles ordered bounded video chunks and correlates control replies', async () => {
    const f = fixture();
    await f.configured;
    f.open();
    const received: ArrayBuffer[] = [];
    f.socket.onmessage = (event: { data: ArrayBuffer }) => received.push(event.data);
    const frame = Buffer.alloc(40_000, 17);
    for (const chunk of simulatorRtcChunks(frame)) {
      f.channels.media.onmessage({ data: Uint8Array.from(chunk).buffer });
    }
    expect(received.map((data) => Buffer.from(data))).toEqual([frame]);
    const abort = new AbortController();
    const result = f.socket.requestControl({ requestId: 'one', action: 'home' }, abort.signal);
    f.channels.control.onmessage({
      data: JSON.stringify({ type: 'rtc-control-result', requestId: 'other', success: false }),
    });
    f.channels.control.onmessage({
      data: JSON.stringify({ type: 'rtc-control-result', requestId: 'one', success: true }),
    });
    expect(await result).toMatchObject({ requestId: 'one', success: true });
    f.socket.close();
    expect(f.peer().closed).toBe(true);
  });

  it('rejects uncertain controls on disconnect without replaying them over WebSocket', async () => {
    const f = fixture();
    await f.configured;
    f.open();
    const closed: number[] = [];
    f.socket.onclose = (event: { code: number }) => closed.push(event.code);
    const result = f.socket.requestControl(
      { requestId: 'one', action: 'home' },
      new AbortController().signal
    );
    const rejected = expect(result).rejects.toThrow('RTC closed');
    f.channels.control.onclose();
    await rejected;
    expect(closed).toEqual([1000]);
    expect(f.fallback).toHaveLength(0);
    expect(f.socket.readyState).toBe(3);
  });

  it.each([false, true])(
    'signals a relay without waiting for blocked UDP gathering (early=%s)',
    async (early) => {
      const f = fixture({ gathering: true });
      await (early ? f.creatingPeer : f.gatheringListening);
      f.peer().localDescription.sdp = 'a=candidate:1 1 udp 1 192.0.2.1 443 typ relay\r\n';
      f.peer().dispatchEvent(new Event('icecandidate'));
      await f.configured;
      expect(f.peer().iceGatheringState).toBe('gathering');
      expect(f.fallback).toHaveLength(0);
      f.socket.close();
    }
  );

  it('closes on a discontinuous frame instead of displaying corrupted pixels', async () => {
    const f = fixture();
    await f.configured;
    f.open();
    const chunk = Uint8Array.from([...simulatorRtcChunks(Buffer.alloc(20_000))][1]!);
    f.channels.media.onmessage({ data: chunk.buffer });
    expect(f.socket.readyState).toBe(3);
    expect(f.peer().closed).toBe(true);
  });
});
