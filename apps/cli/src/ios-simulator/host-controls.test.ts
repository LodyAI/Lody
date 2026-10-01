import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { runSimulatorHostControl } from './host-controls';

it('uses fixed argv and stdin for Unicode, falling back when devicectl is unavailable', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'lody-host-control-'));
  const executable = join(scratch, 'xcrun');
  const record = join(scratch, 'calls');
  try {
    await writeFile(
      executable,
      `#!${process.execPath}
      const fs=require('node:fs');if(process.env.LC_ALL!=='en_US.UTF-8')process.exit(5);let input='';
      process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
      process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({args:process.argv.slice(2),input})+'\\n');process.exit(process.argv[2]==='devicectl'?64:0)});
    `,
      { mode: 0o700 }
    );
    const signal = new AbortController().signal;
    await runSimulatorHostControl('device', { kind: 'text', text: '你好 🌏' }, signal, executable);
    await runSimulatorHostControl(
      'device',
      { kind: 'open-url', url: 'demo://settings' },
      signal,
      executable
    );
    await runSimulatorHostControl(
      'device',
      { kind: 'appearance', appearance: 'dark' },
      signal,
      executable
    );
    await runSimulatorHostControl('device', { kind: 'shake' }, signal, executable);
    expect(
      (await readFile(record, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      {
        args: ['devicectl', 'device', 'pasteboard', 'copy', '--device', 'device'],
        input: '你好 🌏',
      },
      { args: ['simctl', 'pbcopy', 'device'], input: '你好 🌏' },
      { args: ['simctl', 'openurl', 'device', 'demo://settings'], input: '' },
      { args: ['simctl', 'ui', 'device', 'appearance', 'dark'], input: '' },
      {
        args: ['simctl', 'spawn', 'device', 'notifyutil', '-p', 'com.apple.UIKit.SimulatorShake'],
        input: '',
      },
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it('does not settle cancellation until the directly owned command has closed', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'lody-host-cancel-'));
  const executable = join(scratch, 'xcrun'),
    marker = join(scratch, 'closed');
  const server = createServer((_req, res) => res.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('bind');
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  try {
    await writeFile(
      executable,
      `#!${process.execPath}
      const fs=require('node:fs');
      process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'joined');process.exit(0)});
      require('node:http').get('http://127.0.0.1:${address.port}',res=>res.resume());
      setInterval(()=>{},1000);
    `,
      { mode: 0o700 }
    );
    const ready = once(server, 'request');
    running = runSimulatorHostControl(
      'device',
      { kind: 'open-url', url: 'demo://test' },
      abort.signal,
      executable
    );
    const rejection = expect(running).rejects.toThrow('Simulator control failed');
    await ready;
    abort.abort();
    await rejection;
    expect(await readFile(marker, 'utf8')).toBe('joined');
  } finally {
    abort.abort();
    await running?.catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
