// Synthetic loopback only. The child intentionally has no uncaught-error handler.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

export async function probeUndici(
  modulePath = createRequire(import.meta.url).resolve('undici'),
  malformed = true
) {
  const sockets = new Set();
  let requests = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {}); // The fixed client may abort the rejected response.
    socket.once('data', () => {
      requests++;
      socket.end(
        malformed
          ? 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Encoding: gzip,gzip,gzip,gzip,gzip,gzip\r\nConnection: close\r\n\r\n'
          : 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'
      );
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const code = `const {fetch}=require(${JSON.stringify(modulePath)});
      fetch(${JSON.stringify(
        url
      )}).then(r=>r.text()).then(body=>console.log(JSON.stringify({body})))
      .catch(error=>console.log(JSON.stringify({rejected:error.message})));`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    });
    return { ...result, requests, runtime: process.version };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await probeUndici(process.argv[2]), null, 2));
}
