import { startProcessLegacy, type ProcessHandleLegacy } from '@lody/shared/node/process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { IosSimulatorDeviceControlSchema } from '@lody/shared';
import { createGuestButtons } from './guest-buttons';
import { runSimulatorHostControl } from './host-controls';

// IPC is ownership: losing the daemon always reaps the native server.
const abort = new AbortController();
const stop = () => abort.abort();
const buttons = createGuestButtons(abort.signal);
process.on('disconnect', stop);
let pendingHostControl: Promise<void> | undefined;
const onMessage = (raw: unknown) => {
  const request = z
    .object({
      type: z.literal('control'),
      id: z.number().int().positive(),
      udid: z.string().uuid(),
      control: z.union([
        IosSimulatorDeviceControlSchema,
        z.object({ kind: z.enum(['prepare-keyboard', 'prepare-buttons']) }).strict(),
      ]),
    })
    .strict()
    .safeParse(raw);
  if (!request.success || pendingHostControl || abort.signal.aborted) {
    stop();
    return;
  }
  const { id, udid, control } = request.data;
  if (
    !(control.kind === 'button' && ['home', 'app-switcher', 'lock'].includes(control.button)) &&
    control.kind !== 'text' &&
    control.kind !== 'appearance' &&
    control.kind !== 'open-url' &&
    control.kind !== 'shake' &&
    control.kind !== 'prepare-buttons' &&
    control.kind !== 'prepare-keyboard'
  ) {
    stop();
    return;
  }
  pendingHostControl = (
    control.kind === 'prepare-buttons'
      ? buttons.prepare(udid)
      : control.kind === 'button'
        ? buttons.press(udid, z.enum(['home', 'app-switcher', 'lock']).parse(control.button))
        : runSimulatorHostControl(
            udid,
            control,
            AbortSignal.any([abort.signal, AbortSignal.timeout(10000)])
          )
  )
    .then(
      () => {
        if (process.connected) process.send?.({ type: 'control-result', id, success: true });
      },
      () => {
        if (process.connected) process.send?.({ type: 'control-result', id, success: false });
      }
    )
    .finally(() => {
      pendingHostControl = undefined;
    });
};
process.on('message', onMessage);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
let owned: ProcessHandleLegacy | undefined;
let exited: Promise<void> | undefined;
try {
  if (!process.connected) throw new Error('Missing lifecycle owner');
  const binary = z.string().min(1).parse(process.argv[2]);
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Port allocation failed');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve()))
  );
  abort.signal.throwIfAborted();
  owned = startProcessLegacy({
    command: binary,
    args: ['serve', '--host', '127.0.0.1', '--port', String(port), '--no-plugins'],
    processGroup: true,
    options: { stdio: 'ignore', env: process.env },
  });
  const child = owned.child;
  exited = new Promise<void>((resolve) => {
    child?.once('error', () => {
      stop();
      resolve();
    });
    child?.once('exit', () => {
      stop();
      resolve();
    });
  });
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
  while (true) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/simulators`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      if (response.ok) break;
    } catch {
      signal.throwIfAborted();
    }
    await delay(100, undefined, { signal });
  }
  process.send?.({ type: 'ready', port });
  await new Promise<void>((resolve) => {
    if (abort.signal.aborted) resolve();
    else abort.signal.addEventListener('abort', () => resolve(), { once: true });
  });
} catch {
  process.exitCode = 1;
} finally {
  stop();
  await pendingHostControl;
  await buttons.close().catch(() => {
    process.exitCode = 1;
  });
  if (owned) {
    // Keep IPC ownership through whole-tree cleanup, even if the leader exited.
    await owned.terminate({ graceMs: 3000, killWaitMs: 2000 });
    await exited;
  }
  process.removeListener('disconnect', stop);
  process.removeListener('message', onMessage);
  if (process.connected) process.disconnect();
}
