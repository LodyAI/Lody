import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseLsofListeningPids,
  parseSsListeningPids,
  parseWindowsListeningPids,
  stopPreviewTargetProcess,
} from './preview-process';

describe('preview-process', () => {
  it('parses lsof -F pun output strictly for matching port, uid, and loopback/wildcard listen sockets', () => {
    const sample = [
      'p1234',
      'u501',
      'n127.0.0.1:3000',
      'p1235',
      'u501',
      'n[::1]:3000',
      'p1236',
      'u501',
      'n*:3000',
      'p1237',
      'u501',
      'n192.168.1.50:3000',
      'p1238',
      'u501',
      'n127.0.0.1:3000->127.0.0.1:51234',
      'p1239',
      'u0',
      'n127.0.0.1:3000',
      'p1240',
      'u501',
      'n127.0.0.1:4000',
    ].join('\n');

    expect(parseLsofListeningPids(sample, { port: 3000, uid: 501 })).toEqual([1234, 1235, 1236]);
  });

  it('parses Linux ss listening output strictly for matching loopback/wildcard port', () => {
    const sample = [
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=4242,fd=19))',
      'LISTEN 0 511 [::1]:5173 [::]:* users:(("vite",pid=4243,fd=20))',
      'LISTEN 0 511 10.0.0.5:5173 0.0.0.0:* users:(("other",pid=9999,fd=10))',
      'LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=8888,fd=10))',
    ].join('\n');

    expect(parseSsListeningPids(sample, 5173)).toEqual([4242, 4243]);
  });

  it('parses Windows Get-NetTCPConnection PIDs while skipping system PIDs', () => {
    expect(parseWindowsListeningPids('0\n4\n1234\n1234\n5678\nnot-a-pid\n')).toEqual([1234, 5678]);
  });

  it('rejects non-loopback targets before inspecting processes', async () => {
    await expect(
      stopPreviewTargetProcess({ protocol: 'http', host: '192.168.1.10', port: 3000 })
    ).rejects.toThrow(/non-loopback/i);
  });

  it('stops a child server listening on a loopback port without harming the test runner', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const http = require('http');
        const server = http.createServer((_req, res) => res.end('ok'));
        server.listen(0, '127.0.0.1', () => {
          process.stdout.write(String(server.address().port) + '\\n');
        });
        `,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const line = buffer.split('\n')[0]?.trim();
          if (line && /^\d+$/.test(line)) resolve(Number(line));
        });
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Child exited early (${code})`)));
      });

      const exitPromise = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const result = await stopPreviewTargetProcess({
        protocol: 'http',
        host: '127.0.0.1',
        port,
      });
      expect(result.stoppedPids).toContain(child.pid);
      await exitPromise;
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
    }
  });
});
