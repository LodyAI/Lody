import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { startBaguetteProcess } from './baguette-process';

it('joins native cleanup when its IPC lifecycle lease ends', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'lody-simulator-lifecycle-'));
  const worker = join(scratch, 'worker.mjs');
  const binary = join(scratch, 'fake-baguette');
  const marker = join(scratch, 'cleaned');
  let handle: Awaited<ReturnType<typeof startBaguetteProcess>> | undefined;
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('./baguette-worker.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import { createRequire as __lodyCreateRequire } from 'node:module'; const require = __lodyCreateRequire(import.meta.url);",
      },
      outfile: worker,
      logLevel: 'silent',
    });
    await writeFile(
      binary,
      `#!${process.execPath}\nimport http from 'node:http';\nimport fs from 'node:fs';\nconst port=Number(process.argv[process.argv.indexOf('--port')+1]);\nconst server=http.createServer((_req,res)=>res.end('[]'));\nserver.listen(port,'127.0.0.1');\nprocess.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>{fs.writeFileSync(${JSON.stringify(marker)},'reaped');process.exit(0);});});\n`,
      { mode: 0o700 }
    );
    const abort = new AbortController();
    handle = await startBaguetteProcess(binary, abort.signal, worker);
    expect((await fetch(`http://127.0.0.1:${handle.port}/simulators`)).status).toBe(200);
    abort.abort();
    await handle.closed;
    expect(await readFile(marker, 'utf8')).toBe('reaped');
    await expect(fetch(`http://127.0.0.1:${handle.port}/simulators`)).rejects.toThrow();
  } finally {
    await handle?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('joins descendants even when the native parent exits first', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'lody-simulator-descendants-'));
  const worker = join(scratch, 'worker.mjs');
  const binary = join(scratch, 'fake-baguette');
  const marker = join(scratch, 'descendant-cleaned');
  let handle: Awaited<ReturnType<typeof startBaguetteProcess>> | undefined;
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('./baguette-worker.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import { createRequire as __lodyCreateRequire } from 'node:module'; const require = __lodyCreateRequire(import.meta.url);",
      },
      outfile: worker,
      logLevel: 'silent',
    });
    const descendant = `const fs = require('node:fs');
      process.on('SIGTERM', () => {fs.writeFileSync(${JSON.stringify(marker)}, 'reaped'); process.exit(0)});
      process.send('ready'); setInterval(() => {}, 1000);`;
    await writeFile(
      binary,
      `#!${process.execPath}
      import http from 'node:http';
      import {spawn} from 'node:child_process';
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore','ignore','ignore','ipc']});
      const port = Number(process.argv[process.argv.indexOf('--port')+1]);
      descendant.once('message', () => http.createServer((_req,res) => res.end('[]')).listen(port,'127.0.0.1'));
      process.on('SIGTERM', () => process.exit(0));
    `,
      { mode: 0o700 }
    );
    handle = await startBaguetteProcess(binary, new AbortController().signal, worker);
    await handle.stop();
    expect(await readFile(marker, 'utf8')).toBe('reaped');
  } finally {
    await handle?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

it('joins an active host command before resolving worker closure on owner disconnect', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'lody-simulator-host-owner-'));
  const worker = join(scratch, 'worker.mjs'),
    binary = join(scratch, 'fake-baguette');
  const command = join(scratch, 'xcrun'),
    marker = join(scratch, 'host-cleaned');
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const readyServer = createServer((_req, res) => res.end());
  readyServer.listen(0, '127.0.0.1');
  await once(readyServer, 'listening');
  const address = readyServer.address();
  if (!address || typeof address === 'string') throw Error('bind');
  let handle: Awaited<ReturnType<typeof startBaguetteProcess>> | undefined;
  try {
    await writeFile(
      command,
      `#!${process.execPath}
      const fs=require('node:fs');
      process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'joined');process.exit(0)});
      require('node:http').get('http://127.0.0.1:${address.port}',res=>res.resume());
      setInterval(()=>{},1000);
    `,
      { mode: 0o700 }
    );
    await writeFile(
      binary,
      `#!${process.execPath}
      const http=require('node:http');
      http.createServer((_req,res)=>res.end('[]')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');
    `,
      { mode: 0o700 }
    );
    await build({
      entryPoints: [fileURLToPath(new URL('./baguette-worker.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import { createRequire as __lodyCreateRequire } from 'node:module'; const require = __lodyCreateRequire(import.meta.url);",
      },
      outfile: worker,
      logLevel: 'silent',
      plugins: [
        {
          name: 'owned-host-command-fixture',
          setup(builder) {
            builder.onLoad({ filter: /\/host-controls\.ts$/ }, async ({ path }) => {
              const source = await readFile(path, 'utf8');
              // Substitute only the executable dependency; lifecycle and IPC are production code.
              return {
                contents: source.replace(
                  "executable = '/usr/bin/xcrun'",
                  `executable = ${JSON.stringify(command)}`
                ),
                loader: 'ts',
              };
            });
          },
        },
      ],
    });
    handle = await startBaguetteProcess(binary, new AbortController().signal, worker);
    const ready = once(readyServer, 'request');
    const pending = handle.control('5519CB11-71C9-46D9-AEFF-73C96F1104E0', {
      kind: 'open-url',
      url: 'demo://fixture',
    });
    const rejection = expect(pending).rejects.toThrow();
    await ready;
    await handle.stop();
    await rejection;
    expect(await readFile(marker, 'utf8')).toBe('joined');
  } finally {
    await handle?.stop();
    await new Promise<void>((resolve) => readyServer.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
