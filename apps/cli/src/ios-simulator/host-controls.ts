import { spawn } from 'node:child_process';
import type { IosSimulatorDeviceControl } from '@lody/shared';

export type SimulatorHostControl = Extract<
  IosSimulatorDeviceControl,
  { kind: 'text' | 'appearance' | 'open-url' | 'shake' }
>;

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
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        // The IPC worker has a filtered environment. simctl decodes stdin with
        // the locale, so an unset locale rejects non-ASCII pasteboard contents.
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      });
      let kill: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        child.kill('SIGTERM');
        kill ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      // EPIPE is reported by the child's exit status, never with the input contents.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      let failed = false;
      child.once('error', () => {
        failed = true;
      });
      child.once('close', (code) => {
        clearTimeout(kill);
        signal.removeEventListener('abort', cancel);
        if (signal.aborted || failed) reject(new Error('Simulator control failed.'));
        else resolve(code);
      });
    });
  }
  let code: number | null;
  switch (control.kind) {
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
