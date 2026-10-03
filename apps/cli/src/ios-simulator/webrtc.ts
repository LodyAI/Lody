import { randomUUID } from 'node:crypto';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { WebSocket } from 'ws';
import {
  IosSimulatorDeviceControlRequestSchema,
  type IosSimulatorDeviceControlResult,
} from '@lody/shared';
import { simulatorRtcChunks, type SimulatorIceServer } from './webrtc-protocol';

/** One authenticated viewer. No user-controlled upstream URLs or ICE servers.
 * Loop back through the existing stream boundary so touch/lease/codec validation
 * is identical for WS and RTC. Only the external hop changes transport.
 */
export async function createSimulatorRtcPeer(options: {
  sdp: string;
  iceServers: SimulatorIceServer[];
  streamUrl: string;
  origin: string;
  signal: AbortSignal;
  active(): boolean;
  control(request: unknown): Promise<IosSimulatorDeviceControlResult>;
  onClose(): void;
}) {
  const id = randomUUID();
  // Werift selects only the first TURN URL, unlike browsers. Prefer TLS/443 so
  // hosts behind UDP-blocking networks actually use the advertised relay fallback.
  const iceServers = options.iceServers
    .map((server) => ({
      ...server,
      urls: [...server.urls].sort(
        (a, b) =>
          Number(b.startsWith('turns:') && /:443(?:\?|$)/.test(b)) -
          Number(a.startsWith('turns:') && /:443(?:\?|$)/.test(a))
      ),
    }))
    .sort(
      (a, b) =>
        Number(b.urls.some((url) => url.startsWith('turns:') && /:443(?:\?|$)/.test(url))) -
        Number(a.urls.some((url) => url.startsWith('turns:') && /:443(?:\?|$)/.test(url)))
    );
  const pc = new RTCPeerConnection({ iceServers });
  let upstream: WebSocket | undefined;
  let media: RTCDataChannel | undefined;
  let control: RTCDataChannel | undefined;
  let closing: Promise<void> | undefined;
  let lastInput = performance.now();
  let sending = false;
  const frames: Buffer[] = [];
  let queuedBytes = 0;
  let pendingControl = false;
  const subscriptions: Array<() => void> = [];
  const cancel = () => {
    void close();
  };
  const expiry = setTimeout(cancel, 20_000);
  const watchdog = setInterval(() => {
    if (!options.active() || performance.now() - lastInput > 45_000) cancel();
  }, 5000);
  watchdog.unref?.();
  const close = (): Promise<void> => {
    if (closing) return closing;
    clearTimeout(expiry);
    clearInterval(watchdog);
    options.signal.removeEventListener('abort', cancel);
    for (const unsubscribe of subscriptions) unsubscribe();
    frames.length = 0;
    queuedBytes = 0;
    upstream?.terminate();
    closing = pc.close().finally(options.onClose);
    return closing;
  };
  const sendControl = (value: string) => {
    if (control?.readyState !== 'open' || control.bufferedAmount > 128 * 1024) return cancel();
    try {
      control.send(value);
    } catch {
      cancel();
    }
  };
  const start = () => {
    if (closing || upstream || media?.readyState !== 'open' || control?.readyState !== 'open')
      return;
    if (!options.active()) return cancel();
    clearTimeout(expiry);
    lastInput = performance.now();
    upstream = new WebSocket(options.streamUrl, {
      origin: options.origin,
      maxPayload: 17 * 1024 * 1024,
    });
    upstream.on('error', cancel);
    upstream.on('close', (code) => {
      // Preserve codec fallback semantics without exposing native errors.
      sendControl(JSON.stringify({ type: 'rtc-close', code: code === 4002 ? 4002 : 1000 }));
      cancel();
    });
    upstream.on('open', () => sendControl(JSON.stringify({ type: 'rtc-ready' })));
    upstream.on('message', (data, binary) => {
      if (closing || !options.active()) return cancel();
      if (!binary) return sendControl(data.toString());
      // The inner flow already limits in-flight frames by decoded ACKs. Reject
      // overload instead of accumulating another unbounded transport queue.
      if (media?.readyState !== 'open') return cancel();
      const frame = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      if (queuedBytes + frame.length > 4 * 1024 * 1024 || frames.length >= 64) return cancel();
      frames.push(frame);
      queuedBytes += frame.length;
      if (sending) return;
      sending = true;
      void (async () => {
        while (frames.length) {
          if (closing) return;
          const next = frames.shift();
          if (!next) break;
          for (const chunk of simulatorRtcChunks(next)) {
            for (;;) {
              if (closing || !options.active() || media?.readyState !== 'open') return;
              if (media.bufferedAmount <= 256 * 1024) break;
              await media.bufferedAmountLow.asPromise(5000);
            }
            if (closing || !options.active() || media?.readyState !== 'open') return;
            media.send(chunk);
          }
          queuedBytes -= next.length;
        }
      })()
        .catch(cancel)
        .finally(() => {
          sending = false;
        });
    });
  };
  subscriptions.push(
    pc.onDataChannel.subscribe((channel) => {
      if (
        (channel.label !== 'media' && channel.label !== 'control') ||
        !channel.ordered ||
        channel.maxRetransmits != null ||
        channel.maxPacketLifeTime != null
      )
        return cancel();
      if (channel.label === 'media') {
        if (media) return cancel();
        media = channel;
        media.bufferedAmountLowThreshold = 128 * 1024;
        subscriptions.push(channel.onMessage.subscribe(cancel).unSubscribe);
      } else {
        if (control) return cancel();
        control = channel;
        subscriptions.push(
          channel.onMessage.subscribe((message) => {
            if (
              closing ||
              !options.active() ||
              typeof message !== 'string' ||
              message.length > 128 * 1024
            )
              return cancel();
            lastInput = performance.now();
            let raw: unknown;
            try {
              raw = JSON.parse(message);
            } catch {
              return cancel();
            }
            const parsed = IosSimulatorDeviceControlRequestSchema.safeParse(raw);
            if (parsed.success) {
              if (pendingControl)
                return sendControl(
                  JSON.stringify({
                    type: 'rtc-control-result',
                    requestId: parsed.data.requestId,
                    success: false,
                    error: 'busy',
                  })
                );
              pendingControl = true;
              void options
                .control(parsed.data)
                .then((result) => {
                  if (!closing && options.active())
                    sendControl(
                      JSON.stringify({
                        type: 'rtc-control-result',
                        requestId: parsed.data.requestId,
                        ...result,
                      })
                    );
                })
                .catch(cancel)
                .finally(() => {
                  pendingControl = false;
                });
            } else {
              if (
                message.length > 4096 ||
                upstream?.readyState !== WebSocket.OPEN ||
                upstream.bufferedAmount > 65536
              )
                return cancel();
              upstream.send(message);
            }
          }).unSubscribe
        );
      }
      subscriptions.push(
        channel.stateChanged.subscribe((state) => {
          if (state === 'open') start();
          if (state === 'closed') cancel();
        }).unSubscribe
      );
      start();
    }).unSubscribe
  );
  subscriptions.push(
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') cancel();
    }).unSubscribe
  );
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    options.signal.throwIfAborted();
    await pc.setRemoteDescription({ type: 'offer', sdp: options.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    if (closing || !options.active() || options.signal.aborted || !pc.localDescription)
      throw Error('RTC cancelled');
    return { id, sdp: pc.localDescription.sdp, close };
  } catch (error) {
    await close();
    throw error;
  }
}
