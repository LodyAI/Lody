import path from 'node:path';
import {
  getSeaContext,
  readSelectedInstallation,
  type ManagedInstallation,
  type SeaContext,
} from './managed-daemon-release';
import {
  signalChildTreeNowLegacy,
  startProcessLegacy,
  type ProcessExit,
} from '@lody/shared/node/process';
import { toShared } from '@/platform/process-options';

const forwardedCommand = (argv: readonly string[]): boolean => {
  const command = argv[0];
  if (command === undefined) return true;
  return (
    command !== 'daemon' &&
    command !== 'daemon-runner' &&
    command !== '__internal' &&
    !command.startsWith('__')
  );
};

export type ManagedDaemonForwardingPorts = {
  readSelected: (context: SeaContext) => Promise<ManagedInstallation>;
  start: (
    installation: ManagedInstallation,
    args: readonly string[],
    onSignal: (signal: NodeJS.Signals) => void
  ) => { exited: Promise<ProcessExit> };
  warn: (message: string) => void;
};

const defaultPorts: ManagedDaemonForwardingPorts = {
  readSelected: readSelectedInstallation,
  start: (installation, args, onSignal) => {
    const processGroup = process.platform !== 'win32';
    const child = startProcessLegacy({
      command: installation.node,
      args: [installation.bin, ...args],
      options: {
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      },
      processGroup,
    });
    const forward = (signal: NodeJS.Signals) => {
      signalChildTreeNowLegacy(child.child, signal, { processGroup }, toShared());
      onSignal(signal);
    };
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    return {
      exited: child.exited.finally(() => {
        process.removeListener('SIGINT', forward);
        process.removeListener('SIGTERM', forward);
      }),
    };
  },
  warn: (message) => console.warn(message),
};

const signalExitCode: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export async function forwardToSelectedManagedInstallation(
  argv: readonly string[] = process.argv.slice(2),
  ports: Partial<ManagedDaemonForwardingPorts> = {},
  sea: SeaContext | null = getSeaContext()
): Promise<boolean> {
  if (!sea || !forwardedCommand(argv)) return false;
  const effectivePorts = { ...defaultPorts, ...ports };
  let installation: ManagedInstallation;
  try {
    installation = await effectivePorts.readSelected(sea);
  } catch (error) {
    effectivePorts.warn(
      `Could not read the selected managed Lody release; using the embedded release: ${String(error)}`
    );
    return false;
  }
  if (path.resolve(installation.bin) === path.resolve(path.join(sea.releaseDir, 'index.js')))
    return false;
  let signal: NodeJS.Signals | undefined;
  const child = effectivePorts.start(installation, argv, (received) => {
    signal = received;
  });
  const result = await child.exited;
  if (result.code !== null) process.exitCode = result.code;
  else if (result.signal) process.exitCode = signalExitCode[result.signal] ?? 1;
  else if (signal) process.exitCode = signalExitCode[signal] ?? 1;
  return true;
}
