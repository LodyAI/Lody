import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { SessionProcessHandle } from '../../session/session-sandbox';
import type { ResolvedStdioMcpServer } from '@lody/shared';

// ACP agents launch stdio commands themselves. Forward bytes, not configuration or secrets,
// from their process tree to the already scoped, environment-isolated MCP server.
const relay = `const net=require('node:net');const s=net.connect(Number(process.argv[1]),'127.0.0.1',()=>{s.write(process.argv[2]+'\\n');process.stdin.pipe(s);s.pipe(process.stdout)});s.on('error',()=>process.exit(1));s.on('close',()=>process.exit());`;
export async function bindWorkflowStdio(name: string, handle: SessionProcessHandle) {
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<import('node:net').Socket>();
  let claimed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    function handshake(chunk: Buffer) {
      const end = chunk.indexOf(10);
      if (pending.length + (end < 0 ? chunk.length : end) > token.length) {
        socket.destroy();
        return;
      }
      pending = Buffer.concat([pending, chunk.subarray(0, end < 0 ? chunk.length : end)]);
      if (end < 0) return;
      socket.off('data', handshake);
      const { stdin, stdout } = handle.child;
      if (
        claimed ||
        !stdin ||
        !stdout ||
        pending.length !== token.length ||
        !timingSafeEqual(pending, Buffer.from(token))
      ) {
        socket.destroy();
        return;
      }
      claimed = true;
      server.close();
      for (const other of sockets) if (other !== socket) other.destroy();
      stdin.write(chunk.subarray(end + 1));
      socket.pipe(stdin);
      stdout.pipe(socket);
      socket.once('close', () => {
        void handle.terminate(false).catch(() => {});
      });
    }
    socket.on('data', handshake);
  });
  const close = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  try {
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    handle.onClose(close);
    if (handle.child.exitCode !== null || handle.child.signalCode !== null)
      throw Error('Workflow MCP exited');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Invalid workflow endpoint');
    const entry: ResolvedStdioMcpServer = {
      name,
      command: process.execPath,
      args: ['-e', relay, String(address.port), token],
      env: process.versions.electron ? [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] : [],
    };
    return {
      entry,
      release: async () => {
        close();
        await handle.terminate(false);
      },
    };
  } catch (error) {
    close();
    await handle.terminate(true);
    throw error;
  }
}

/** The child listens on LODY_MCP_SOCKET. Only the authenticated loopback facade is sent to the ACP client. */
export async function bindWorkflowHttp(
  name: string,
  handle: SessionProcessHandle,
  socketPath: string
) {
  const { createServer, request } = await import('node:http');
  const token = randomBytes(32).toString('hex');
  const server = createServer((input, out) => {
    if (input.headers.authorization !== `Bearer ${token}` || input.url !== '/mcp') {
      out.writeHead(403).end();
      return;
    }
    const headers = { ...input.headers };
    delete headers.authorization;
    const upstream = request({ method: input.method, path: '/mcp', headers, socketPath }, (res) => {
      out.writeHead(res.statusCode ?? 500, res.headers);
      res.pipe(out);
    });
    upstream.on('error', () => out.destroy());
    out.on('close', () => upstream.destroy());
    input.pipe(upstream);
  });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  try {
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    handle.onClose(close);
    const address = server.address();
    if (
      !address ||
      typeof address === 'string' ||
      handle.child.exitCode !== null ||
      handle.child.signalCode !== null
    )
      throw Error('HTTP workflow unavailable');
    return {
      entry: {
        name,
        type: 'http' as const,
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      },
      release: async () => {
        close();
        await handle.terminate(false);
      },
    };
  } catch (e) {
    close();
    await handle.terminate(true);
    throw e;
  }
}
