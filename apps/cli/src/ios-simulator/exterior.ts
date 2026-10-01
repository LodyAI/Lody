import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  IosSimulatorExteriorSchema,
  IOS_SIMULATOR_BEZEL_MAX_BYTES,
  isIosSimulatorBezelPng,
} from '@lody/shared';

const Size = z.object({ width: z.number().positive(), height: z.number().positive() });
const Rect = Size.extend({ x: z.number(), y: z.number() });
const Definition = z.object({
  screen: z.object({
    viewport: Size,
    rect: Rect,
    clipRadius: z.number().nonnegative(),
    buttonMargins: z.object({
      left: z.number().nonnegative(),
      right: z.number().nonnegative(),
      top: z.number().nonnegative(),
      bottom: z.number().nonnegative(),
    }),
  }),
  buttons: z
    .array(
      z.object({
        envelope: z.object({ type: z.string(), button: z.string().optional() }),
        box: z.object({
          leftPct: z.number(),
          topPct: z.number(),
          widthPct: z.number(),
          heightPct: z.number(),
        }),
      })
    )
    .max(16),
});

/** Read only the bound device's immutable DeviceKit assets. Never trust upstream URLs. */
export async function readSimulatorExterior(options: {
  port: number;
  udid: string;
  signal: AbortSignal;
  active(): boolean;
  fetch?: typeof fetch;
}) {
  async function read(route: string, limit: number) {
    if (!options.active()) throw new Error('Simulator unavailable.');
    const response = await (options.fetch ?? fetch)(
      `http://127.0.0.1:${options.port}/simulators/${encodeURIComponent(options.udid)}/${route}`,
      {
        redirect: 'error',
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(10000)]),
      }
    );
    if (!response.ok || !response.body) throw new Error('Device exterior unavailable.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new Error('Device exterior too large.');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    if (!options.active()) throw new Error('Simulator unavailable.');
    return Buffer.concat(chunks);
  }
  const definition = Definition.parse(
    JSON.parse((await read('definition.json', 65536)).toString('utf8'))
  );
  const { viewport, rect, clipRadius, buttonMargins: m } = definition.screen;
  const width = viewport.width + m.left + m.right,
    height = viewport.height + m.top + m.bottom;
  const buttons = definition.buttons.flatMap(({ envelope, box }) => {
    const button = envelope.button === 'power' ? 'lock' : envelope.button;
    if (
      envelope.type !== 'button' ||
      !['home', 'lock', 'volume-up', 'volume-down', 'action'].includes(button ?? '')
    )
      return [];
    return [
      {
        button,
        x: (box.leftPct * viewport.width) / 100 + m.left,
        y: (box.topPct * viewport.height) / 100 + m.top,
        width: (box.widthPct * viewport.width) / 100,
        height: (box.heightPct * viewport.height) / 100,
      },
    ];
  });
  const geometry = IosSimulatorExteriorSchema.parse({
    width,
    height,
    screen: { ...rect, x: rect.x + m.left, y: rect.y + m.top, radius: clipRadius },
    buttons,
  });
  const png = await read('bezel.png', IOS_SIMULATOR_BEZEL_MAX_BYTES);
  if (!isIosSimulatorBezelPng(png, geometry)) throw new Error('Invalid device exterior.');
  return { geometry, png };
}

/** Read immutable DeviceKit artwork without booting, streaming, leasing or opening a server. */
export async function readIdleSimulatorExterior(binary: string, udid: string, signal: AbortSignal) {
  const exec = promisify(execFile);
  const target = z.string().uuid().parse(udid);
  const { stdout: layout } = await exec(binary, ['chrome', 'layout', '--udid', target], {
    signal,
    timeout: 10000,
    maxBuffer: 65536,
    encoding: 'utf8',
  });
  const { stdout: png } = await exec(binary, ['chrome', 'composite', '--udid', target], {
    signal,
    timeout: 10000,
    maxBuffer: 256 * 1024,
    encoding: 'buffer',
  });
  return parseIdleSimulatorExterior(layout, png);
}

export function parseIdleSimulatorExterior(layout: string, png: Buffer) {
  const parsed = z
    .object({
      composite: Size,
      screen: Rect,
      innerCornerRadius: z.number().nonnegative(),
    })
    .parse(JSON.parse(layout));
  const geometry = IosSimulatorExteriorSchema.parse({
    ...parsed.composite,
    screen: { ...parsed.screen, radius: parsed.innerCornerRadius },
    buttons: [],
  });
  if (png.length > 256 * 1024 || !isIosSimulatorBezelPng(png, geometry))
    throw new Error('Invalid device exterior.');
  return { geometry, pngBase64: png.toString('base64') };
}
