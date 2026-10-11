import { Effect } from 'effect';
import { processLayer, runCommand } from '@lody/shared/node/process';
import type { IosSimulatorDeviceControl } from '@lody/shared';

export type SimulatorHostControl =
  | Extract<IosSimulatorDeviceControl, { kind: 'text' | 'appearance' | 'open-url' | 'shake' }>
  | { kind: 'prepare-keyboard' | 'prepare-buttons' }
  | { kind: 'button'; button: 'home' | 'app-switcher' | 'lock' };

/** Run only fixed simctl/devicectl commands, inside the IPC lifecycle worker.
 * Unlike Foundation.Process children, these direct children can be cancelled and joined. */
export async function runSimulatorHostControl(
  udid: string,
  control: SimulatorHostControl,
  signal: AbortSignal,
  executable = '/usr/bin/xcrun'
): Promise<void> {
  async function run(args: string[], input?: string): Promise<number | null> {
    signal.throwIfAborted();
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          runCommand({
            command: executable,
            args,
            input: input ?? '',
            // simctl decodes stdin with the locale; keep Unicode clipboard input.
            env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
            abandonPolicy: { graceMs: 1000, killWaitMs: 2000 },
          }),
          processLayer({})
        ),
        { signal }
      );
      return result.code;
    } catch {
      // Keep command input and subprocess diagnostics out of RPC and logs.
      throw new Error('Simulator control failed.');
    }
  }
  let code: number | null;
  switch (control.kind) {
    case 'prepare-buttons':
    case 'button':
      throw new Error('Simulator buttons require the owned guest service.');
    case 'prepare-keyboard':
      code = await run([
        'simctl',
        'spawn',
        udid,
        'defaults',
        'write',
        'com.apple.Preferences',
        'AutomaticMinimizationEnabled',
        '-bool',
        'false',
      ]);
      if (code === 0)
        code = await run([
          'simctl',
          'spawn',
          udid,
          'notifyutil',
          '-p',
          'com.apple.keyboard.preferences.changed',
        ]);
      break;
    case 'text':
      // Xcode 27 devicectl fixes pbcopy's silent no-op; older Xcodes use simctl.
      code = await run(
        ['devicectl', 'device', 'pasteboard', 'copy', '--device', udid],
        control.text
      );
      if (code !== 0) code = await run(['simctl', 'pbcopy', udid], control.text);
      break;
    case 'shake':
      code = await run([
        'simctl',
        'spawn',
        udid,
        'notifyutil',
        '-p',
        'com.apple.UIKit.SimulatorShake',
      ]);
      break;
    case 'appearance':
      code = await run(['simctl', 'ui', udid, 'appearance', control.appearance]);
      break;
    case 'open-url':
      code = await run(['simctl', 'openurl', udid, control.url]);
      break;
  }
  if (code !== 0) throw new Error('Simulator control failed.');
}
