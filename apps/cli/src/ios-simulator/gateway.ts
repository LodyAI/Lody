import { SimulatorIdleRefresh, readSimulatorStill } from './idle-refresh';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { simulatorViewerHtml } from './viewer';
import { readSimulatorExterior } from './exterior';
import {
  IosSimulatorDeviceControlRequestSchema,
  type IosSimulatorDeviceControlResult,
} from '@lody/shared';
import { createSimulatorDeviceControls } from './device-controls';
import type { SimulatorHostControl } from './host-controls';
import { SimulatorFrameFlow, jpegDimensions, simulatorScale } from './frame-flow';
import type { Logger } from '@/utils/logger';

const Input = z
  .object({
    type: z.enum(['touch1-down', 'touch1-move', 'touch1-up']),
    x: z.number().finite().min(0).max(16384),
    y: z.number().finite().min(0).max(16384),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    edge: z.literal('bottom').optional(),
  })
  .strict()
  .refine((v) => v.x <= v.width && v.y <= v.height);
const Heartbeat = z.object({ type: z.literal('heartbeat') }).strict();
const MediaMessage = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('stream-config'),
      width: z.number().int().min(1).max(8192),
      height: z.number().int().min(1).max(8192),
      dpr: z.number().finite().min(0.5).max(2),
    })
    .strict(),
  z
    .object({ type: z.literal('frame-ack'), sequence: z.number().int().min(1).max(0xffffffff) })
    .strict(),
  z
    .object({ type: z.literal('pong'), id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
    .strict(),
]);
/** Only a fixed viewer and one UDID stream. Never exposes the Baguette HTTP API. */
export async function createSimulatorGateway(options: {
  operationId: string;
  udid: string;
  port: number;
  softwareKeyboard?: boolean;
  remote?: boolean;
  logger?: Pick<Logger, 'debug'>;
  signal?: AbortSignal;
  hostControl(control: SimulatorHostControl): Promise<void>;
  active(): boolean;
  renew(): void;
}) {
  const path = `/simulator/${randomBytes(32).toString('hex')}/`;
  let origin: string | undefined;
  const validOrigin = (host: string | undefined, requestOrigin: string | undefined) =>
    origin !== undefined &&
    host === new URL(origin).host &&
    (!requestOrigin || requestOrigin === origin);
  const sockets = new Set<Socket>();
  const invalidateStills = new Set<() => void>();
  const upstreams = new Set<WebSocket>();
  const connections = new Set<() => Promise<void>>();
  const controlAbort = new AbortController();
  const controls = createSimulatorDeviceControls({
    port: options.port,
    softwareKeyboard: options.softwareKeyboard,
    udid: options.udid,
    signal: options.signal
      ? AbortSignal.any([controlAbort.signal, options.signal])
      : controlAbort.signal,
    active: () => !controlAbort.signal.aborted && options.active(),
    hostControl: (control) => options.hostControl(control),
  });
  // A device survives Stop. Establish a native baseline once per operation, not per iframe load.
  await controls.initialize();
  let pendingControl: Promise<IosSimulatorDeviceControlResult> | undefined;
  const completedControls = new Map<
    string,
    { hash: string; result: IosSimulatorDeviceControlResult }
  >();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  let exterior: ReturnType<typeof readSimulatorExterior> | undefined;
  const server = createServer((req, res) => {
    if (!options.active()) {
      res.writeHead(410).end();
      return;
    }
    const requestedPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (
      req.method === 'GET' &&
      validOrigin(req.headers.host, req.headers.origin) &&
      (requestedPath === `${path}exterior.json` || requestedPath === `${path}bezel.png`)
    ) {
      exterior ??= readSimulatorExterior({
        port: options.port,
        udid: options.udid,
        signal: options.signal
          ? AbortSignal.any([controlAbort.signal, options.signal])
          : controlAbort.signal,
        active: options.active,
      });
      void exterior
        .then((asset) => {
          if (!options.active() || controlAbort.signal.aborted) {
            res.writeHead(410).end();
            return;
          }
          const png = requestedPath.endsWith('bezel.png');
          res.writeHead(200, {
            'Content-Type': png ? 'image/png' : 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(png ? asset.png : JSON.stringify(asset.geometry));
        })
        .catch(() => {
          res.writeHead(404).end();
        });
      return;
    }

    if (
      req.method === 'POST' &&
      requestedPath === `${path}control` &&
      validOrigin(req.headers.host, req.headers.origin) &&
      req.headers.origin === origin
    ) {
      const reply = (result: IosSimulatorDeviceControlResult, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      };
      void (async () => {
        if (req.headers['content-type'] !== 'application/json')
          return reply({ success: false, error: 'failed' }, 400);
        req.setTimeout(10000, () => req.destroy());
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Invalid request body.');
          const bytes = chunk;
          size += bytes.length;
          if (size > 128 * 1024) return reply({ success: false, error: 'failed' }, 413);
          chunks.push(bytes);
        }
        const parsed = IosSimulatorDeviceControlRequestSchema.safeParse(
          JSON.parse(Buffer.concat(chunks).toString('utf8'))
        );
        if (!parsed.success || parsed.data.operationId !== options.operationId)
          return reply({ success: false, error: 'failed' }, 400);
        if (!options.active() || controlAbort.signal.aborted)
          return reply({ success: false, error: 'unavailable' }, 410);
        const { requestId, control } = parsed.data;
        const hash = createHash('sha256').update(JSON.stringify(control)).digest('hex');
        const prior = completedControls.get(requestId);
        if (prior)
          return reply(
            prior.hash === hash
              ? { ...prior.result, rotation: controls.rotation() }
              : { success: false, error: 'failed' }
          );
        if (pendingControl) return reply({ success: false, error: 'busy' });
        for (const invalidate of invalidateStills) invalidate();
        const task = controls
          .execute(control)
          .then((): IosSimulatorDeviceControlResult => {
            if (!options.active() || controlAbort.signal.aborted)
              return { success: false, error: 'unavailable' };
            options.renew();
            return { success: true, rotation: controls.rotation() };
          })
          .catch((): IosSimulatorDeviceControlResult => ({
            success: false,
            error: options.active() && !controlAbort.signal.aborted ? 'failed' : 'unavailable',
          }));
        pendingControl = task;
        const result = await task;
        pendingControl = undefined;
        completedControls.set(requestId, { hash, result });
        if (completedControls.size > 32) {
          const oldest = completedControls.keys().next().value;
          if (oldest !== undefined) completedControls.delete(oldest);
        }
        reply(result);
      })().catch(() => {
        if (!res.headersSent) reply({ success: false, error: 'failed' }, 400);
      });
      return;
    }
    if (
      req.method !== 'GET' ||
      !validOrigin(req.headers.host, req.headers.origin) ||
      new URL(req.url ?? '/', 'http://localhost').pathname !== path
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:",
    });
    res.end(simulatorViewerHtml(options.operationId, controls.rotation(), options.remote ?? false));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    if (
      !options.active() ||
      !validOrigin(req.headers.host, req.headers.origin) ||
      new URL(req.url ?? '/', 'http://localhost').pathname !== `${path}stream`
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(
        `ws://127.0.0.1:${options.port}/simulators/${options.udid}/stream?format=mjpeg&version=1`,
        { maxPayload: 16 * 1024 * 1024 }
      );
      upstreams.add(upstream);
      let touch: z.infer<typeof Input> | undefined;
      let shuttingDown: Promise<void> | undefined;
      const now = () => performance.now();
      const flow = new SimulatorFrameFlow(options.remote ?? false, now());
      let viewport: { width: number; height: number; dpr: number } | undefined;
      let nativeSize: { width: number; height: number } | undefined;
      let observedScale = 1;
      let scale = 1,
        pingId = 0,
        samples = 0;
      let ping: { id: number; at: number } | undefined;
      const idle = new SimulatorIdleRefresh(
        (stillScale, signal) =>
          readSimulatorStill({
            port: options.port,
            udid: options.udid,
            scale: stillScale,
            signal,
            active: options.active,
          }),
        (frame) => {
          if (!shuttingDown && options.active()) {
            flow.offer(frame, true);
            pump();
          }
        },
        () => flow.discardStill()
      );
      const invalidateStill = () => idle.activity(now());
      invalidateStills.add(invalidateStill);
      let lastScaleAt = -Infinity;
      const configure = () => {
        if (
          !viewport ||
          !nativeSize ||
          upstream.readyState !== WebSocket.OPEN ||
          now() - lastScaleAt < 1000
        )
          return;
        const next = flow.recommendedScale(
          simulatorScale(nativeSize, viewport, options.remote ?? false),
          observedScale
        );
        // Lower quality quickly; recover it slowly so content changes do not flap
        // the native encoder. The first viewport adjustment is immediate.
        if (next < scale && now() - lastScaleAt < 10000) return;
        if (next !== scale) {
          scale = next;
          lastScaleAt = now();
          upstream.send(JSON.stringify({ type: 'set_scale', scale }));
        }
      };
      const pump = () => {
        if (shuttingDown) return;
        if (!options.active()) {
          close();
          return;
        }
        if (flow.oldestAge(now()) > 10000) {
          close();
          return;
        }
        configure();
        if (!viewport || client.readyState !== WebSocket.OPEN || client.bufferedAmount > 256 * 1024)
          return;
        const packet = flow.take(now());
        if (packet) client.send(packet, { binary: true });
        if (options.remote && nativeSize && !pendingControl)
          idle.tick(now(), simulatorScale(nativeSize, viewport, true), flow.drained() && !touch);
      };
      // A timer flushes the last pending frame even when the simulator becomes static.
      const frameTimer = setInterval(pump, Math.ceil(1000 / flow.targetFps));
      const probe = () => {
        if (ping || client.readyState !== WebSocket.OPEN) return;
        ping = { id: ++pingId, at: now() };
        client.send(JSON.stringify({ type: 'ping', id: ping.id }));
      };
      // Establish a propagation baseline ahead of the first (native-sized) JPEG.
      probe();
      const statsTimer = setInterval(() => {
        if (shuttingDown || !options.active()) {
          close();
          return;
        }
        const stats = { ...flow.snapshot(now()), scale, remote: options.remote ?? false };
        if (++samples % 15 === 0)
          options.logger?.debug('[iOS Simulator media] ' + JSON.stringify(stats));
        if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 64 * 1024) return;
        client.send(JSON.stringify({ type: 'stream-stats', ...stats }));
        probe();
      }, 2000);
      const shutdown = (): Promise<void> => {
        if (shuttingDown) return shuttingDown;
        clearInterval(frameTimer);
        clearInterval(statsTimer);
        invalidateStills.delete(invalidateStill);
        const idleClosed = idle.close();
        shuttingDown = new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            upstream.terminate();
            client.terminate();
            upstreams.delete(upstream);
            resolve();
          };
          const timer = setTimeout(finish, 1000);
          upstream.once('close', finish);
          client.terminate();
          if (upstream.readyState === WebSocket.OPEN) {
            if (touch) upstream.send(JSON.stringify({ ...touch, type: 'touch1-up' }));
            touch = undefined;
            // close() drains the touch-up before its Close frame; terminate() would discard it.
            upstream.close();
          } else finish();
        }).then(async () => {
          await idleClosed;
          connections.delete(shutdown);
        });
        return shuttingDown;
      };
      const close = () => {
        void shutdown();
      };
      connections.add(shutdown);
      client.on('error', close);
      upstream.on('error', close);
      client.on('close', close);
      upstream.on('close', close);
      client.on('message', (data, binary) => {
        if (shuttingDown || !options.active()) {
          close();
          return;
        }
        if (binary) {
          close();
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          close();
          return;
        }
        if (Heartbeat.safeParse(raw).success) {
          options.renew();
          return;
        }
        const media = MediaMessage.safeParse(raw);
        if (media.success) {
          const message = media.data;
          if (message.type === 'stream-config') {
            invalidateStill();
            viewport = message;
            configure();
            pump();
          } else if (message.type === 'frame-ack') {
            if (!flow.acknowledge(message.sequence, now())) {
              close();
              return;
            }
            pump();
          } else if (ping?.id === message.id) {
            flow.recordRtt(now() - ping.at);
            ping = undefined;
          }
          // Configuration, ACKs and probes do not renew the control lease.
          return;
        }
        const parsed = Input.safeParse(raw);
        if (!parsed.success || upstream.readyState !== WebSocket.OPEN) {
          close();
          return;
        }
        const input = parsed.data;
        if ((input.type === 'touch1-down' && touch) || (input.type !== 'touch1-down' && !touch))
          return;
        // An edge belongs to the gesture's starting point, never a mid-drag switch.
        if (
          (input.type === 'touch1-down' && input.edge && input.y < input.height * 0.93) ||
          (touch && input.edge !== touch.edge)
        ) {
          close();
          return;
        }
        invalidateStill();
        touch = input.type === 'touch1-up' ? undefined : input;
        options.renew();
        if (upstream.bufferedAmount > 64 * 1024) {
          close();
          return;
        }
        upstream.send(JSON.stringify(input));
      });
      upstream.on('message', (data, binary) => {
        if (shuttingDown || !options.active()) {
          close();
          return;
        }
        if (binary) {
          const frame = Buffer.isBuffer(data)
            ? data
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : Buffer.concat(data);
          const size = jpegDimensions(frame);
          nativeSize ??= size;
          if (nativeSize && size)
            observedScale = Math.max(
              1,
              Math.round(
                Math.max(nativeSize.width, nativeSize.height) / Math.max(size.width, size.height)
              )
            );
          invalidateStill();
          flow.offer(frame);
          pump();
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Simulator gateway did not bind.');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    port: address.port,
    path,
    close: async () => {
      controlAbort.abort();
      await pendingControl;
      completedControls.clear();
      await Promise.all([...connections].map((shutdown) => shutdown()));
      for (const ws of upstreams) ws.terminate();
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
    },
  };
}
