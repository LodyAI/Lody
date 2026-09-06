import path from 'node:path';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import {
  assertWindowsSupervisorArtifacts,
  windowsSupervisorName,
} from './windows-supervisor-artifacts.mjs';

/** Exercise the packaged native job, launcher, split chunks, and Node-mode environment. */
export async function probeWindowsSupervisor({ directory, runtimePath }) {
  if (process.platform !== 'win32') throw new Error('Windows supervisor probe requires Windows');
  assertWindowsSupervisorArtifacts({ directory, architectures: [process.arch] });
  const marker = 'lody-windows-supervisor-probe-ok';
  const source = `if(process.env.ELECTRON_RUN_AS_NODE!=='1'||process.env.LODY_WINDOWS_TARGET_NODE_MODE!==undefined)process.exitCode=1;else process.stdout.write(${JSON.stringify(marker)});`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(directory, windowsSupervisorName(process.arch)),
      [
        '--owner-pid',
        String(process.pid),
        '--',
        path.resolve(runtimePath),
        path.join(directory, 'windows-process-launcher.js'),
        path.resolve(runtimePath),
        '-e',
        source,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          LODY_WINDOWS_TARGET_NODE_MODE: JSON.stringify('1'),
        },
      }
    );
    const control = child.stdio[3];
    let state = 'ready';
    let buffer = '';
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail('deadline exceeded'), 15_000);
    function fail(reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // fd3 withdrawal and termination address only this spawned supervisor;
      // its private job owns teardown of the launcher and synthetic target.
      control?.destroy();
      try {
        child.kill();
      } catch {
        /* Preserve the probe failure. */
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error(`[windows-supervisor-smoke] ${reason}`));
    }
    child.on('error', () => fail('supervisor failed to launch'));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal !== null || state !== 'complete' || stdout !== marker) {
        fail('owned launcher did not complete the synthetic Node target');
        return;
      }
      settled = true;
      clearTimeout(timer);
      control?.destroy();
      resolve();
    });
    child.stdout?.on('data', (chunk) => {
      if (stdout.length + chunk.length > 4096) {
        fail('unexpected target output');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4096) fail('unexpected target diagnostics');
    });
    if (!(control instanceof Duplex)) {
      fail('control channel unavailable');
      return;
    }
    control.on('error', () => fail('control channel failed'));
    control.on('data', (chunk) => {
      if (buffer.length + chunk.length > 4096) {
        fail('invalid control response');
        return;
      }
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail('invalid control response');
          return;
        }
        if (state === 'ready' && message?.type === 'ready' && message.protocol === 1) {
          state = 'prepared';
          control.write('start\n');
        } else if (
          state === 'prepared' &&
          message?.type === 'prepared' &&
          Number.isSafeInteger(message.pid) &&
          message.pid > 0
        ) {
          state = 'started';
          control.write('resume\n');
        } else if (state === 'started' && message?.type === 'started') {
          state = 'complete';
        } else {
          fail('unexpected control response');
          return;
        }
      }
    });
  });
}
