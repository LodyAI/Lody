import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { simulatorViewerHtml } from './viewer';
import {
  IosSimulatorDeviceControlRequestSchema,
  type IosSimulatorDeviceControlResult,
} from '@lody/shared';
import { createSimulatorDeviceControls } from './device-controls';
import type { SimulatorHostControl } from './host-controls';

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
/** Only a fixed viewer and one UDID stream. Never exposes the Baguette HTTP API. */
export async function createSimulatorGateway(options: {
  operationId: string;
  udid: string;
  port: number;
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
  const upstreams = new Set<WebSocket>();
  const connections = new Set<() => Promise<void>>();
  const controlAbort = new AbortController();
  const controls = createSimulatorDeviceControls({
    port: options.port,
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
  const server = createServer((req, res) => {
    if (!options.active()) {
      res.writeHead(410).end();
      return;
    }
    const requestedPath = new URL(req.url ?? '/', 'http://localhost').pathname;
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
    res.end(simulatorViewerHtml(options.operationId, controls.rotation()));
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
      const shutdown = (): Promise<void> => {
        if (shuttingDown) return shuttingDown;
        shuttingDown = new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            upstream.terminate();
            client.terminate();
            upstreams.delete(upstream);
            connections.delete(shutdown);
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
        // JPEGs are independent frames; dropping while congested cannot corrupt a GOP.
        if (
          binary &&
          client.readyState === WebSocket.OPEN &&
          client.bufferedAmount < 2 * 1024 * 1024
        )
          client.send(data, { binary: true });
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
