import { it, expect } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { openAndroidConnection } from '../src/android-emulator/connection';

it.skipIf(!process.env.LODY_TEST_AVD || !process.env.LODY_TEST_SCRCPY_SERVER)(
  'streams H264 from the explicitly selected configured AVD and releases capture',
  async () => {
    const runtime = process.env.LODY_TEST_SCRCPY_SERVER;
    const avd = process.env.LODY_TEST_AVD;
    if (!runtime || !avd) throw Error('Set LODY_TEST_SCRCPY_SERVER and LODY_TEST_AVD');
    const connection = await openAndroidConnection(runtime, avd, new AbortController().signal);
    const gateway = await connection.gateway({
      operationId: 'smoke',
      signal: new AbortController().signal,
      active: () => true,
      renew: () => {},
      iceServers: async () => [],
    });
    const origin = `http://127.0.0.1:${gateway.port}`;
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}${gateway.path}stream?codec=h264`, {
      origin,
    });
    try {
      const frame = new Promise<Buffer>((resolve, reject) => {
        socket.on('error', reject);
        socket.on('message', (data, binary) => {
          if (binary) resolve(Buffer.from(data as Buffer));
        });
      });
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'stream-config', width: 600, height: 1000, dpr: 1 }));
      const packet = await frame;
      expect(packet.readUInt32BE(0)).toBe(0x4c415643);
      expect(packet.length).toBeGreaterThan(20);
    } finally {
      socket.close();
      await gateway.close();
      await connection.stop();
    }
  },
  45000
);
