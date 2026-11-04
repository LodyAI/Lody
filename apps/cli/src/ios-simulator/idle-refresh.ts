import { jpegDimensions } from './frame-flow';

export { SimulatorIdleRefresh } from '../device-preview/idle-refresh';

/** Fixed loopback route only; no browser-supplied paths, options, or redirects. */
export async function readSimulatorStill(options: {
  port: number;
  udid: string;
  scale: number;
  signal: AbortSignal;
  active(): boolean;
  fetch?: typeof fetch;
}) {
  if (!options.active()) throw new Error('Simulator unavailable.');
  const scale = Math.max(1, Math.min(4, Math.round(options.scale)));
  const response = await (options.fetch ?? fetch)(
    `http://127.0.0.1:${options.port}/simulators/${encodeURIComponent(options.udid)}/screenshot.jpg?scale=${scale}&quality=0.85`,
    { redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) }
  );
  if (!response.ok || !response.body) throw new Error('Simulator still unavailable.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 512 * 1024) throw new Error('Simulator still too large.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  if (!options.active() || options.signal.aborted) throw new Error('Simulator unavailable.');
  const frame = Buffer.concat(chunks);
  if (!jpegDimensions(frame)) throw new Error('Invalid simulator still.');
  return frame;
}
