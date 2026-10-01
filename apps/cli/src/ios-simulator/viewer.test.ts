import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulatorViewerHtml } from './viewer';

type Input = { type: string; x?: number; y?: number; width?: number; height?: number };
type Pointer = {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
};
type Wheel = {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  preventDefault(): void;
};

// Execute the exact inline artifact with deterministic browser boundaries. The output
// is the actual WebSocket protocol, not a second implementation of its input logic.
function viewer(
  options: {
    videoDecoder?: unknown;
    suspendRaf?: boolean;
    rotation?: number;
    rotateWithDevice?: boolean;
    fetch?: typeof fetch;
    decode?: () => Promise<{ width: number; height: number; close(): void }>;
  } = {}
) {
  vi.useFakeTimers();
  const sent: Input[] = [];
  const events = new Map<string, Array<(event: unknown) => unknown>>();
  const emit = (name: string, event: unknown) =>
    Promise.all((events.get(name) ?? []).map((handler) => handler(event)));
  const messages: Record<string, unknown>[] = [];
  const captures: Array<{ width: number; height: number }> = [];
  let framePainted: (() => void) | undefined;
  let sequence = 0;
  let paints = 0;
  const wheelEvents = new Map<string, (event: Wheel) => void>();
  const canvas = {
    width: 1200,
    height: 2000,
    style: {},
    getContext: () => ({
      drawImage() {
        paints++;
        framePainted?.();
      },
    }),
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 600, height: 1000 }),
    setPointerCapture: (_id: number) => {},
    addEventListener: (name: string, handler: (event: Wheel) => void) =>
      wheelEvents.set(name, handler),
    onpointerdown: (_event: Pointer) => {},
    onpointermove: (_event: Pointer) => {},
    onpointerup: (_event: Pointer) => {},
    onpointercancel: (_event: Pointer) => {},
    onlostpointercapture: (_event: Pointer) => {},
  };
  const document = {
    hidden: false,
    querySelector: () => canvas,
    createElement: () => {
      const output = {
        width: 0,
        height: 0,
        getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }),
        toBlob: (callback: (blob: Blob) => void) => {
          captures.push({ width: output.width, height: output.height });
          callback(new Blob(['png'], { type: 'image/png' }));
        },
      };
      return output;
    },
  };
  const parent = {
    postMessage: (message: Record<string, unknown>) => {
      messages.push(message);
    },
  };
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    onopen = () => {};
    onerror = () => {};
    onclose = (_event?: { code: number }) => {};
    onmessage = (_event: { data: ArrayBuffer | string }) => {};
    constructor(readonly url: URL) {
      sockets.push(this);
    }
    send(value: string) {
      sent.push(JSON.parse(value) as Input);
    }
    close() {
      this.readyState = 3;
      this.onclose();
    }
  }
  const html = simulatorViewerHtml('test-operation', options.rotation ?? 0);
  const script = html.slice(
    html.indexOf('<script>') + '<script>'.length,
    html.indexOf('</script>')
  );
  runInNewContext(script, {
    document,
    parent,
    location: { href: 'http://127.0.0.1:1234/viewer', protocol: 'http:' },
    URL,
    Blob,
    ArrayBuffer,
    DataView,
    performance: { now: () => Date.now() },
    devicePixelRatio: 2,
    requestAnimationFrame: (callback: () => void) =>
      setTimeout(callback, options.suspendRaf ? 60000 : 16),
    cancelAnimationFrame: clearTimeout,
    AbortController,
    AbortSignal,
    TextDecoder,
    Uint8Array,
    innerWidth: 600,
    innerHeight: 1000,
    fetch: (url: string, init?: RequestInit) =>
      String(url).includes('exterior.json')
        ? Promise.resolve(new Response('', { status: 404 }))
        : (
            options.fetch ??
            (async () => new Response(JSON.stringify({ success: true, rotation: 90 })))
          )(url, init),
    createImageBitmap: options.decode ?? (async () => ({ width: 1200, height: 2000, close() {} })),
    WebSocket: Socket,
    VideoDecoder: options.videoDecoder,
    EncodedVideoChunk: class {
      constructor(readonly init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: (name: string, handler: (event: unknown) => unknown) =>
      events.set(name, [...(events.get(name) ?? []), handler]),
  });
  function visibility(visible: boolean, type = 'lody:ios-simulator:visibility') {
    void emit('message', {
      source: parent,
      origin: 'https://lody.example',
      data: {
        type,
        operationId: 'test-operation',
        visible,
        rotateWithDevice: options.rotateWithDevice,
      },
    });
  }
  visibility(true, 'lody:ios-simulator:init');
  sockets.at(-1)?.onopen();
  const pointer = (overrides: Partial<Pointer> = {}): Pointer => ({
    pointerId: 1,
    button: 0,
    clientX: 400,
    clientY: 550,
    preventDefault() {},
    ...overrides,
  });
  return {
    get sent() {
      return sent.filter((input) => input.type.startsWith('touch'));
    },
    wire: sent,
    sockets,
    receiveVideo(id: number, key = false) {
      const description = key ? new Uint8Array([1, 66, 0, 30, 255, 225, 0]) : new Uint8Array();
      const data = new ArrayBuffer(12 + description.length),
        h = new DataView(data);
      h.setUint32(0, 0x4c415643);
      h.setUint32(4, id);
      h.setUint8(8, key ? 2 : 3);
      h.setUint16(9, description.length);
      new Uint8Array(data, 11, description.length).set(description);
      sockets.at(-1)?.onmessage({ data });
    },
    receiveFrame(id: number) {
      const data = new ArrayBuffer(9),
        header = new DataView(data);
      header.setUint32(0, 0x4c4f4459);
      header.setUint32(4, id);
      sockets.at(-1)?.onmessage({ data });
    },
    get paints() {
      return paints;
    },
    messages,
    captures,
    async paint() {
      const ready = new Promise<void>((resolve) => {
        framePainted = resolve;
      });
      const data = new ArrayBuffer(9),
        header = new DataView(data);
      header.setUint32(0, 0x4c4f4459);
      header.setUint32(4, ++sequence);
      sockets.at(-1)?.onmessage({ data });
      await vi.advanceTimersByTimeAsync(16);
      await ready;
    },
    command(
      data: Record<string, unknown>,
      origin = 'https://lody.example',
      source: unknown = parent
    ) {
      return emit('message', {
        source,
        origin,
        data: { operationId: 'test-operation', requestId: 'test-request', ...data },
      });
    },
    canvas,
    pointer,
    visibility,
    event: (name: string) => {
      void emit(name, {});
    },
    disconnect: () => sockets.at(-1)?.close(),
    wheel(overrides: Partial<Wheel> = {}) {
      let prevented = false;
      wheelEvents.get('wheel')?.({
        clientX: 400,
        clientY: 550,
        deltaX: 0,
        deltaY: 60,
        deltaMode: 0,
        ctrlKey: false,
        ...overrides,
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('simulator viewer input', () => {
  it('keeps one decode and the latest pending frame, and discards an old generation on hide', async () => {
    const decoders: Array<(image: { width: number; height: number; close(): void }) => void> = [];
    let released = 0;
    const v = viewer({ decode: () => new Promise((resolve) => decoders.push(resolve)) });
    const image = () => ({
      width: 1200,
      height: 2000,
      close: () => {
        released++;
      },
    });
    v.receiveFrame(1);
    await vi.advanceTimersByTimeAsync(16);
    v.receiveFrame(2);
    v.receiveFrame(3);
    v.receiveFrame(4);
    expect(v.paints).toBe(0);
    decoders.shift()?.(image());
    await vi.advanceTimersByTimeAsync(16);
    expect(v.paints).toBe(1);
    decoders.shift()?.(image());
    await vi.advanceTimersByTimeAsync(16);
    expect(v.wire.filter((input) => input.type === 'frame-ack')).toEqual([
      { type: 'frame-ack', sequence: 1 },
      { type: 'frame-ack', sequence: 4 },
    ]);
    v.receiveFrame(5);
    await vi.advanceTimersByTimeAsync(16);
    v.visibility(false);
    v.visibility(true);
    decoders.shift()?.(image());
    await vi.advanceTimersByTimeAsync(16);
    expect(v.paints).toBe(2);
    expect(released).toBe(3);
    expect(v.wire.filter((input) => input.type === 'frame-ack')).toHaveLength(2);
  });

  it('coalesces pointer moves per animation frame and flushes the final release without replay', () => {
    const v = viewer();
    v.canvas.onpointerdown(v.pointer());
    for (let n = 0; n < 100; n++) v.canvas.onpointermove(v.pointer({ clientY: 600 + n }));
    expect(v.sent.map((input) => input.type)).toEqual(['touch1-down']);
    vi.advanceTimersByTime(16);
    expect(v.sent).toHaveLength(2);
    expect(v.sent.at(-1)?.y).toBe(1298);
    v.canvas.onpointermove(v.pointer({ clientY: 720 }));
    v.canvas.onpointerup(v.pointer({ clientY: 730 }));
    expect(v.sent.slice(-2)).toMatchObject([
      { type: 'touch1-move', y: 1340 },
      { type: 'touch1-up', y: 1360 },
    ]);
    const count = v.sent.length;
    vi.advanceTimersByTime(32);
    expect(v.sent).toHaveLength(count);
  });

  it('ACKs drawn sequences, preserves same-sized canvas contents and exports numeric diagnostics', async () => {
    const v = viewer();
    let resets = 0,
      width = v.canvas.width,
      height = v.canvas.height;
    Object.defineProperty(v.canvas, 'width', {
      get: () => width,
      set: (value) => {
        width = value;
        resets++;
      },
    });
    Object.defineProperty(v.canvas, 'height', {
      get: () => height,
      set: (value) => {
        height = value;
        resets++;
      },
    });
    await v.paint();
    await v.paint();
    expect(v.paints).toBe(2);
    expect(resets).toBe(0);
    expect(v.wire.filter((input) => input.type === 'frame-ack')).toEqual([
      { type: 'frame-ack', sequence: 1 },
      { type: 'frame-ack', sequence: 2 },
    ]);
    v.sockets.at(-1)?.onmessage({
      data: JSON.stringify({
        type: 'stream-stats',
        rttMs: 100,
        sentFps: 30,
        token: 'secret',
        ackMs: 'https://secret.example',
      }),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const sample = v.messages.find((m) => m.type === 'lody:ios-simulator:performance');
    expect(sample?.stats).toMatchObject({
      rttMs: 100,
      sentFps: 30,
      width: 1200,
      height: 2000,
      connected: true,
    });
    expect(sample?.stats).not.toHaveProperty('token');
    expect(sample?.stats).not.toHaveProperty('ackMs');
    v.visibility(false);
    expect(
      v.messages.filter((m) => m.type === 'lody:ios-simulator:performance').at(-1)?.stats
    ).toMatchObject({ connected: false });
  });

  it('samples on the viewer clock even when gateway reports arrive in a burst', async () => {
    const v = viewer();
    await v.paint();
    for (let i = 0; i < 4; i++)
      v.sockets.at(-1)?.onmessage({
        data: JSON.stringify({
          type: 'stream-stats',
          sentFps: i,
          baseRttMs: 400,
          windowBytes: 50000,
        }),
      });
    expect(v.messages.filter((m) => m.type === 'lody:ios-simulator:performance')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    const reports = v.messages.filter((m) => m.type === 'lody:ios-simulator:performance');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.stats).toMatchObject({
      paintedFps: 0.5,
      sentFps: 3,
      baseRttMs: 400,
      windowBytes: 50000,
    });
  });

  it('only accepts private controls from the bound parent and remaps touches after rotation', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const v = viewer({
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ success: true, rotation: 90 }));
      },
    });
    await v.paint();
    const command = {
      type: 'lody:ios-simulator:control',
      control: { kind: 'rotate', direction: 'right' },
    };
    await v.command(command, 'https://untrusted.example');
    await v.command(command, 'https://lody.example', {});
    await v.command({ ...command, operationId: 'other-operation' });
    expect(requests).toEqual([]);
    await v.command(command);
    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:1234/control',
        body: {
          operationId: 'test-operation',
          requestId: 'test-request',
          control: command.control,
        },
      },
    ]);
    expect(v.messages.at(-1)).toMatchObject({
      type: 'lody:ios-simulator:control-result',
      success: true,
    });
    v.canvas.onpointerdown(v.pointer({ clientX: 250, clientY: 800 }));
    expect(v.sent.at(-1)).toEqual({
      type: 'touch1-down',
      x: 900,
      y: 1500,
      width: 1200,
      height: 2000,
    });
    expect(v.messages.find((m) => m.state === 'ready' && m.rotation === 90)).toMatchObject({
      width: 2000,
      height: 1200,
    });
  });

  it('keeps mobile pixels, touch coordinates and capture upright while rotating the guest', async () => {
    const controls: unknown[] = [];
    const v = viewer({
      rotateWithDevice: false,
      fetch: async (_url, init) => {
        controls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ success: true, rotation: 90 }));
      },
    });
    await v.paint();
    await v.command({
      type: 'lody:ios-simulator:control',
      control: { kind: 'rotate', direction: 'right' },
    });
    expect(controls).toEqual([
      expect.objectContaining({ control: { kind: 'rotate', direction: 'right' } }),
    ]);
    expect(v.canvas.style).toMatchObject({ transform: 'rotate(0deg)' });
    expect(v.messages.filter((m) => m.state === 'ready').at(-1)).toMatchObject({
      width: 1200,
      height: 2000,
      rotation: 0,
    });
    v.canvas.onpointerdown(v.pointer({ clientX: 250, clientY: 800 }));
    expect(v.sent.at(-1)).toMatchObject({ x: 300, y: 1500 });
    await v.command({ type: 'lody:ios-simulator:capture' });
    expect(v.captures).toEqual([{ width: 1200, height: 2000 }]);
  });

  it('lifts and suspends gestures until a discrete control finishes', async () => {
    let finish: (response: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const v = viewer({ fetch: () => response });
    await v.paint();
    v.canvas.onpointerdown(v.pointer());
    const control = v.command({
      type: 'lody:ios-simulator:control',
      control: { kind: 'rotate', direction: 'right' },
    });
    expect(v.sent.map(({ type }) => type)).toEqual(['touch1-down', 'touch1-up']);
    v.canvas.onpointerdown(v.pointer());
    v.wheel();
    expect(v.sent).toHaveLength(2);
    finish(new Response(JSON.stringify({ success: true, rotation: 90 })));
    await control;
    v.canvas.onpointerdown(v.pointer());
    expect(v.sent.at(-1)?.type).toBe('touch1-down');
  });

  it('captures an oriented PNG only after a live frame and refuses hidden captures', async () => {
    const v = viewer({ rotation: 90 });
    const command = { type: 'lody:ios-simulator:capture' };
    await v.command(command);
    expect(v.messages.at(-1)).toMatchObject({ error: 'unavailable' });
    await v.paint();
    await v.command(command);
    expect(v.captures).toEqual([{ width: 2000, height: 1200 }]);
    const captured = v.messages.at(-1);
    expect(captured).toMatchObject({
      type: 'lody:ios-simulator:capture-result',
      mimeType: 'image/png',
      requestId: 'test-request',
    });
    expect(Buffer.from(captured?.data as ArrayBuffer).toString()).toBe('png');
    v.visibility(false);
    await v.command(command);
    expect(v.messages.at(-1)).toMatchObject({ error: 'unavailable' });
    expect(v.captures).toHaveLength(1);
  });
  it('preserves the bottom edge through an upward Home gesture, then resets it', () => {
    const v = viewer();
    v.canvas.onpointerdown(v.pointer({ clientY: 1030 }));
    v.canvas.onpointermove(v.pointer({ clientY: 650 }));
    v.canvas.onpointerup(v.pointer({ clientY: 550 }));
    expect(v.sent).toEqual([
      { type: 'touch1-down', x: 600, y: 1960, width: 1200, height: 2000, edge: 'bottom' },
      { type: 'touch1-move', x: 600, y: 1200, width: 1200, height: 2000, edge: 'bottom' },
      { type: 'touch1-up', x: 600, y: 1000, width: 1200, height: 2000, edge: 'bottom' },
    ]);
    v.wheel({ clientY: 1030 });
    expect(v.sent.at(-1)).not.toHaveProperty('edge');
    vi.advanceTimersByTime(120);
    v.canvas.onpointerdown(v.pointer());
    v.canvas.onpointermove(v.pointer({ clientY: 1030 }));
    v.canvas.onpointercancel(v.pointer());
    expect(v.sent.slice(-3)).toEqual([
      { type: 'touch1-down', x: 600, y: 1000, width: 1200, height: 2000 },
      { type: 'touch1-move', x: 600, y: 1960, width: 1200, height: 2000 },
      { type: 'touch1-up', x: 600, y: 1960, width: 1200, height: 2000 },
    ]);
  });
  it('converts wheel scrolling into a scaled finger drag and lifts after the last tick', () => {
    const v = viewer();
    expect(v.wheel()).toBe(true);
    vi.advanceTimersByTime(100);
    v.wheel({ deltaX: 20, deltaY: 30 });
    vi.advanceTimersByTime(119);
    expect(v.sent).toEqual([
      { type: 'touch1-down', x: 600, y: 1000, width: 1200, height: 2000 },
      { type: 'touch1-move', x: 600, y: 880, width: 1200, height: 2000 },
      { type: 'touch1-move', x: 560, y: 820, width: 1200, height: 2000 },
    ]);
    vi.advanceTimersByTime(1);
    expect(v.sent.at(-1)).toEqual({ type: 'touch1-up', x: 560, y: 820, width: 1200, height: 2000 });
  });

  it('continues a long scroll by releasing and restarting before reaching the edge', () => {
    const v = viewer();
    for (let i = 0; i < 8; i++) v.wheel({ deltaY: 250 });
    vi.advanceTimersByTime(120);
    expect(v.sent.map(({ type }) => type)).toEqual(
      Array.from({ length: 8 }, () => ['touch1-down', 'touch1-move', 'touch1-up']).flat()
    );
    for (const input of v.sent) {
      expect(input.x).toBe(600);
      expect(input.y).toBeGreaterThanOrEqual(100);
      expect(input.y).toBeLessThanOrEqual(1900);
    }
  });

  it('supports line and page wheel units, while ignoring pinch and empty input', () => {
    const v = viewer();
    v.wheel({ ctrlKey: true });
    v.wheel({ deltaY: 0 });
    v.wheel({ deltaY: Number.NaN });
    expect(v.sent).toEqual([]);
    v.wheel({ deltaMode: 1, deltaY: -2 });
    vi.advanceTimersByTime(16);
    expect(v.sent.at(-1)?.y).toBe(1064);
    vi.advanceTimersByTime(120);
    v.wheel({ deltaMode: 2, deltaY: 1 });
    vi.advanceTimersByTime(16);
    expect(v.sent.at(-1)?.y).toBe(500);
    vi.advanceTimersByTime(120);
    v.wheel({ deltaMode: 2, deltaX: 0.1, deltaY: 0 });
    vi.advanceTimersByTime(16);
    expect(v.sent.at(-1)?.x).toBe(480);
  });

  it('releases a wheel gesture before a pointer drag and uses the final pointer position', () => {
    const v = viewer();
    v.wheel();
    v.canvas.onpointerdown(v.pointer());
    v.wheel();
    vi.advanceTimersByTime(120);
    v.canvas.onpointermove(v.pointer({ clientY: 500 }));
    v.canvas.onpointerup(v.pointer({ clientY: 450 }));
    expect(v.sent.map(({ type }) => type)).toEqual([
      'touch1-down',
      'touch1-move',
      'touch1-up',
      'touch1-down',
      'touch1-move',
      'touch1-up',
    ]);
    expect(v.sent.at(-1)).toEqual({ type: 'touch1-up', x: 600, y: 800, width: 1200, height: 2000 });
  });

  it('ignores secondary buttons and cancellation from an unrelated pointer', () => {
    const v = viewer();
    v.canvas.onpointerdown(v.pointer({ button: 2 }));
    expect(v.sent).toEqual([]);
    v.canvas.onpointerdown(v.pointer());
    v.canvas.onpointercancel(v.pointer({ pointerId: 2 }));
    v.canvas.onlostpointercapture(v.pointer({ pointerId: 2 }));
    v.canvas.onpointermove(v.pointer({ clientY: 500 }));
    v.canvas.onpointercancel(v.pointer());
    expect(v.sent.map(({ type }) => type)).toEqual(['touch1-down', 'touch1-move', 'touch1-up']);
  });

  it.each(['blur', 'pagehide', 'hidden', 'disconnect'])(
    'cleans up a wheel gesture on %s without a delayed release in the next connection',
    (reason) => {
      const v = viewer();
      v.wheel();
      if (reason === 'hidden') v.visibility(false);
      else if (reason === 'disconnect') v.disconnect();
      else v.event(reason);
      const before = [...v.sent];
      v.visibility(true);
      vi.advanceTimersByTime(120);
      expect(v.sent).toEqual(before);
      if (reason !== 'disconnect') expect(v.sent.at(-1)?.type).toBe('touch1-up');
      v.wheel();
      vi.advanceTimersByTime(16);
      expect(v.sent.slice(-2).map(({ type }) => type)).toEqual(['touch1-down', 'touch1-move']);
    }
  );
});

function fakeVideoCodec(supported = true) {
  const decoders: Decoder[] = [];
  const frames: Array<{
    closed: boolean;
    timestamp: number;
    displayWidth: number;
    displayHeight: number;
    close(): void;
  }> = [];
  class Decoder {
    static async isConfigSupported() {
      return { supported };
    }
    decodeQueueSize = 0;
    closed = false;
    chunks: Array<{ timestamp: number; type: string }> = [];
    constructor(readonly callbacks: { output(frame: unknown): void; error(): void }) {
      decoders.push(this);
    }
    configure() {}
    close() {
      this.closed = true;
    }
    decode(chunk: { timestamp: number; type: string }) {
      this.chunks.push(chunk);
    }
    output(index: number) {
      const chunk = this.chunks[index];
      if (!chunk) throw Error('chunk');
      const frame = {
        closed: false,
        timestamp: chunk.timestamp,
        displayWidth: 600,
        displayHeight: 1300,
        close() {
          this.closed = true;
        },
      };
      frames.push(frame);
      this.callbacks.output(frame);
    }
  }
  return { Decoder, decoders, frames };
}
describe('viewer WebCodecs lifecycle', () => {
  it('decodes dependent frames in order, coalesces only output and ACKs decoded pictures independently of painting', async () => {
    const codec = fakeVideoCodec(),
      v = viewer({ videoDecoder: codec.Decoder });
    expect(v.sockets[0]?.url.searchParams.get('codec')).toBe('h264');
    v.receiveVideo(1, true);
    v.receiveVideo(2);
    v.receiveVideo(3);
    await vi.advanceTimersByTimeAsync(0);
    const d = codec.decoders[0];
    expect(d?.chunks.map((c) => c.type)).toEqual(['key', 'delta', 'delta']);
    d?.output(0);
    d?.output(1);
    d?.output(2);
    expect(codec.frames.map((f) => f.closed)).toEqual([true, true, false]);
    expect(v.wire.filter((m) => m.type === 'frame-ack')).toEqual(
      [1, 2, 3].map((sequence) => ({ type: 'frame-ack', sequence }))
    );
    await vi.advanceTimersByTimeAsync(16);
    expect(v.canvas.width).toBe(600);
    expect(codec.frames.every((f) => f.closed)).toBe(true);
    v.visibility(false);
    expect(d?.closed).toBe(true);
    const stats = v.messages
      .filter((m) => m.type === 'lody:ios-simulator:performance')
      .at(-1)?.stats;
    expect(stats).toMatchObject({ rafPaints: 1, timerPaints: 0, paintScheduleMs: 16 });
  });
  it('falls back once when actual AVC configuration is unsupported and retains JPEG preview', async () => {
    const codec = fakeVideoCodec(false),
      v = viewer({ videoDecoder: codec.Decoder });
    v.receiveVideo(1, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(v.sockets).toHaveLength(2);
    expect(v.sockets[0]?.readyState).toBe(3);
    expect(v.sockets[1]?.url.searchParams.has('codec')).toBe(false);
    v.sockets[1]?.onopen();
    await v.paint();
    expect(v.paints).toBe(1);
    v.visibility(false);
    v.visibility(true);
    expect(v.sockets.at(-1)?.url.searchParams.has('codec')).toBe(false);
  });
  it('keeps decoded credit and bounded painting progressing while RAF is suspended', async () => {
    const codec = fakeVideoCodec(),
      v = viewer({ videoDecoder: codec.Decoder, suspendRaf: true });
    v.receiveVideo(1, true);
    await vi.advanceTimersByTimeAsync(0);
    const decoder = codec.decoders[0];
    for (let i = 0; i < 90; i++) {
      if (i) v.receiveVideo(i + 1);
      decoder?.output(i);
      await vi.advanceTimersByTimeAsync(17);
    }
    expect(v.wire.filter((m) => m.type === 'frame-ack').at(-1)).toEqual({
      type: 'frame-ack',
      sequence: 90,
    });
    expect(codec.frames.filter((f) => !f.closed).length).toBeLessThanOrEqual(1);
    expect(v.paints).toBeGreaterThan(10);
    v.visibility(false);
    const stats = v.messages
      .filter((m) => m.type === 'lody:ios-simulator:performance')
      .at(-1)?.stats;
    expect(stats).toMatchObject({ rafPaints: 0, timerPaints: v.paints, paintScheduleMs: 100 });
    const paints = v.paints;
    await vi.advanceTimersByTimeAsync(1000);
    expect(v.paints).toBe(paints);
    expect(codec.frames.every((f) => f.closed)).toBe(true);
  });
  it('retries transient transport failures with H264 twice, then stops without JPEG downgrade', async () => {
    const codec = fakeVideoCodec(),
      v = viewer({ videoDecoder: codec.Decoder });
    for (let i = 0; i < 3; i++) {
      v.sockets.at(-1)?.onerror();
      await vi.advanceTimersByTimeAsync(2000);
      if (i < 2) v.sockets.at(-1)?.onopen();
    }
    expect(v.sockets).toHaveLength(3);
    expect(v.sockets.every((s) => s.url.searchParams.get('codec') === 'h264')).toBe(true);
    expect(v.sockets.at(-1)?.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(30000);
    expect(v.sockets).toHaveLength(3);
  });
  it('cancels a pending transport retry when hidden and fences callbacks from the old socket', async () => {
    const codec = fakeVideoCodec(),
      v = viewer({ videoDecoder: codec.Decoder });
    const old = v.sockets[0];
    old?.onerror();
    v.visibility(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(v.sockets).toHaveLength(1);
    v.visibility(true);
    v.sockets.at(-1)?.onopen();
    old?.onclose({ code: 4002 });
    expect(v.sockets).toHaveLength(2);
    expect(v.sockets.at(-1)?.url.searchParams.get('codec')).toBe('h264');
  });
  it('reconnects a silent H264 socket but treats an explicit codec rejection as fallback', async () => {
    const codec = fakeVideoCodec(),
      v = viewer({ videoDecoder: codec.Decoder });
    await vi.advanceTimersByTimeAsync(8500);
    expect(v.sockets).toHaveLength(2);
    expect(v.sockets[1]?.url.searchParams.get('codec')).toBe('h264');
    v.sockets[1]?.onopen();
    v.sockets[1]?.onclose({ code: 4002 });
    expect(v.sockets).toHaveLength(3);
    expect(v.sockets[2]?.url.searchParams.has('codec')).toBe(false);
  });
  it('requires a fresh keyframe after decoder overload and releases delayed output after hide', async () => {
    const codec = fakeVideoCodec(),
      v = viewer({ videoDecoder: codec.Decoder });
    v.receiveVideo(1, true);
    await vi.advanceTimersByTimeAsync(0);
    const first = codec.decoders[0];
    if (!first) throw Error('decoder');
    first.decodeQueueSize = 16;
    v.receiveVideo(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closed).toBe(true);
    expect(v.wire.some((m) => m.type === 'keyframe-request')).toBe(true);
    v.receiveVideo(3);
    expect(first.chunks).toHaveLength(1);
    v.receiveVideo(4, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(codec.decoders).toHaveLength(2);
    v.visibility(false);
    codec.decoders[1]?.output(0);
    expect(codec.frames.at(-1)?.closed).toBe(true);
    expect(v.paints).toBe(0);
  });
  it('does not resurrect a decoder after an asynchronous configuration probe resolves on a hidden viewer', async () => {
    const codec = fakeVideoCodec();
    let resolve: (value: { supported: boolean }) => void = () => {};
    codec.Decoder.isConfigSupported = () =>
      new Promise((r) => {
        resolve = r;
      });
    const v = viewer({ videoDecoder: codec.Decoder });
    v.receiveVideo(1, true);
    v.visibility(false);
    resolve({ supported: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(codec.decoders).toHaveLength(0);
    expect(v.paints).toBe(0);
  });
});
