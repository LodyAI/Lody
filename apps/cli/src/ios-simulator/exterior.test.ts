import { expect, it } from 'vitest';
import { readSimulatorExterior, parseIdleSimulatorExterior } from './exterior';

const definition = {
  screen: {
    viewport: { width: 429, height: 888 },
    rect: { x: 18, y: 18, width: 393, height: 852 },
    clipRadius: 57,
    buttonMargins: { left: 9, right: 9, top: 0, bottom: 0 },
    bezelImage: { rest: 'https://untrusted.invalid/asset' },
  },
  buttons: [
    {
      envelope: { type: 'button', button: 'power' },
      box: { leftPct: 96, topPct: 30, widthPct: 3, heightPct: 10 },
    },
  ],
};
const png = Buffer.alloc(24);
png.set([137, 80, 78, 71, 13, 10, 26, 10]);
png.write('IHDR', 12);
png.writeUInt32BE(447, 16);
png.writeUInt32BE(888, 20);
it('normalizes DeviceKit geometry and reads only the bound device fixed routes', async () => {
  const paths: string[] = [];
  const result = await readSimulatorExterior({
    port: 1234,
    udid: 'owned',
    signal: new AbortController().signal,
    active: () => true,
    fetch: async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      return url.pathname.endsWith('definition.json')
        ? new Response(JSON.stringify(definition))
        : new Response(png);
    },
  });
  expect(paths).toEqual(['/simulators/owned/definition.json', '/simulators/owned/bezel.png']);
  expect(result.geometry).toMatchObject({
    width: 447,
    height: 888,
    screen: { x: 27, y: 18, width: 393, height: 852, radius: 57 },
    buttons: [{ button: 'lock' }],
  });
  expect(result.png).toEqual(png);
});
it('rejects an oversized asset and geometry escaping the composite', async () => {
  const options = {
    port: 1234,
    udid: 'owned',
    signal: new AbortController().signal,
    active: () => true,
  };
  await expect(
    readSimulatorExterior({
      ...options,
      fetch: async (input) =>
        String(input).endsWith('definition.json')
          ? new Response(JSON.stringify(definition))
          : new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    })
  ).rejects.toThrow('too large');
  await expect(
    readSimulatorExterior({
      ...options,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...definition,
            screen: { ...definition.screen, rect: { ...definition.screen.rect, width: 10000 } },
          })
        ),
    })
  ).rejects.toThrow();
});
it('discards asset bytes if ownership was revoked during the read', async () => {
  let active = true;
  await expect(
    readSimulatorExterior({
      port: 1234,
      udid: 'owned',
      signal: new AbortController().signal,
      active: () => active,
      fetch: async () => {
        active = false;
        return new Response(JSON.stringify(definition));
      },
    })
  ).rejects.toThrow('unavailable');
});

it('normalizes CLI chrome layout without accepting upstream URLs or oversized PNGs', () => {
  const layout = JSON.stringify({
    composite: { width: 447, height: 888 },
    screen: { x: 27, y: 18, width: 393, height: 852 },
    innerCornerRadius: 57,
    imageUrl: 'https://untrusted.invalid',
    buttons: [{ arbitrary: 'ignored' }],
  });
  expect(parseIdleSimulatorExterior(layout, png)).toEqual({
    geometry: {
      width: 447,
      height: 888,
      screen: { x: 27, y: 18, width: 393, height: 852, radius: 57 },
      buttons: [],
    },
    pngBase64: png.toString('base64'),
  });
  expect(() => parseIdleSimulatorExterior(layout, Buffer.alloc(256 * 1024 + 1))).toThrow();
  expect(() => parseIdleSimulatorExterior(layout.replace('393', '500'), png)).toThrow();
});
