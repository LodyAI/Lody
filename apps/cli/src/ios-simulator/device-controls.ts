import { z } from 'zod';
import type { IosSimulatorDeviceControl } from '@lody/shared';
import type { SimulatorHostControl } from './host-controls';

const Ack = z.object({ ok: z.literal(true) });
const Orientations = [
  'portrait',
  'landscape-left',
  'portrait-upside-down',
  'landscape-right',
] as const;

/** Fixed routes against an owned loopback process. Never proxy a caller's path or URL. */
export function createSimulatorDeviceControls(options: {
  port: number;
  udid: string;
  signal: AbortSignal;
  active(): boolean;
  hostControl(control: SimulatorHostControl): Promise<void>;
  fetch?: typeof fetch;
}) {
  let orientation = 0;
  const base = `http://127.0.0.1:${options.port}/simulators/${encodeURIComponent(options.udid)}/`;
  async function post(route: string, body?: unknown): Promise<unknown> {
    if (!options.active()) throw new Error('Simulator unavailable.');
    const response = await (options.fetch ?? fetch)(new URL(route, base), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok || !response.body) throw new Error('Simulator control failed.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65536) throw new Error('Simulator response too large.');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    if (!options.active()) throw new Error('Simulator unavailable.');
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  const execute = async (control: IosSimulatorDeviceControl): Promise<void> => {
    switch (control.kind) {
      case 'button':
        Ack.parse(
          await post('input', {
            type: 'button',
            button: control.button,
            duration: control.button === 'action' ? 1 : 0,
          })
        );
        return;
      case 'text':
        if (!options.active()) throw new Error('Simulator unavailable.');
        await options.hostControl(control);
        Ack.parse(
          await post('input', { type: 'key', code: 'KeyV', modifiers: ['command'], duration: 0 })
        );
        return;
      case 'rotate': {
        const next = (orientation + (control.direction === 'left' ? 3 : 1)) % 4;
        const value = Orientations[next];
        if (!value) throw new Error('Invalid orientation.');
        Ack.parse(await post(`orientation?value=${value}`));
        orientation = next;
        return;
      }
      case 'shake':
      case 'appearance':
      case 'open-url':
        if (!options.active()) throw new Error('Simulator unavailable.');
        await options.hostControl(control);
        if (!options.active()) throw new Error('Simulator unavailable.');
        return;
    }
  };
  return {
    initialize: async () => {
      Ack.parse(await post('orientation?value=portrait'));
      orientation = 0;
    },
    execute,
    rotation: () => ([0, 90, 180, 270] as const)[orientation] ?? 0,
  };
}
