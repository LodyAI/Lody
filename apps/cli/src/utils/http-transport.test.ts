import dns from 'node:dns';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import type { Duplex } from 'node:stream';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, fetch as undiciFetch } from 'undici';
import { version } from '@/pkg';
import { describe, expect, it, vi } from 'vitest';
import {
  createCliHttpTransport,
  resolveCliHttpTransportConfig,
  installCliHttpGlobalDispatcher,
  getCliHttpFetch,
} from './http-transport';
import { createLogger } from './logger';
import * as proxy from './proxy';

const envOf = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
};

describe('resolveCliHttpTransportConfig', () => {
  it.each(['daemon', 'oneshot'] as const)(
    'identifies %s on SDK global fetch and the disabled-transport CLI fetch',
    async (mode) => {
      const previous = getGlobalDispatcher();
      const previousFetch = globalThis.fetch;
      const argv = process.argv;
      const agent = new MockAgent();
      agent.disableNetConnect();
      const logger = createLogger({ transports: 'console', level: 'silent' });
      try {
        process.argv = ['node', 'lody', mode === 'daemon' ? 'start' : 'session'];
        setGlobalDispatcher(agent);
        globalThis.fetch = undiciFetch as unknown as typeof fetch;
        installCliHttpGlobalDispatcher({ env: envOf({ LODY_HTTP_TRANSPORT: 'native' }), logger });
        for (const path of ['/sdk-stream', '/cli-token']) {
          agent
            .get('https://diagnostics.invalid')
            .intercept({
              path,
              headers: {
                'user-agent': `lody-cli/${version} (${mode})`,
                authorization: 'Bearer synthetic',
              },
            })
            .reply(200, 'identified');
        }
        const sdk = await globalThis.fetch('https://diagnostics.invalid/sdk-stream', {
          headers: { authorization: 'Bearer synthetic' },
        });
        expect(await sdk.text()).toBe('identified');
        const cli = await getCliHttpFetch({
          env: envOf({ LODY_HTTP_TRANSPORT: 'native' }),
          logger,
        })('https://diagnostics.invalid/cli-token', {
          headers: {
            authorization: 'Bearer synthetic',
            'user-agent': 'private-machine-identifier',
          },
        });
        expect(await cli.text()).toBe('identified');
      } finally {
        process.argv = argv;
        globalThis.fetch = previousFetch;
        setGlobalDispatcher(previous);
        await agent.close();
        await logger.close();
      }
    }
  );

  it.each(['direct', 'proxy'])(
    'reaches IPv4 after an unavailable IPv6 address through %s transport',
    async (mode) => {
      const originalSelection = getDefaultAutoSelectFamily();
      setDefaultAutoSelectFamily(false);
      const logger = createLogger({ transports: 'console', level: 'silent' });
      let userAgent: string | undefined;
      const origin = createServer((request, response) => {
        userAgent = request.headers['user-agent'];
        response.end('reachable via IPv4');
      });
      const gateway = createServer();
      const sockets = new Set<Duplex>();
      let tunnelEstablished = false;
      const track = (socket: Duplex) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      };
      const transport = createCliHttpTransport(resolveCliHttpTransportConfig(envOf({})), logger);
      try {
        origin.listen(0, '127.0.0.1');
        await once(origin, 'listening');
        const address = origin.address();
        if (!address || typeof address === 'string') throw new Error('missing origin port');
        gateway.on('connect', (_request, socket, head) => {
          const upstream = connect(address.port, '127.0.0.1');
          track(upstream);
          track(socket);
          upstream.on('error', () => socket.destroy());
          socket.on('error', () => upstream.destroy());
          upstream.on('connect', () => {
            tunnelEstablished = true;
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            socket.pipe(upstream).pipe(socket);
          });
        });
        gateway.listen(0, '127.0.0.1');
        await once(gateway, 'listening');
        const gatewayAddress = gateway.address();
        if (!gatewayAddress || typeof gatewayAddress === 'string')
          throw new Error('missing proxy port');
        vi.spyOn(proxy, 'resolveProxyUrl').mockReturnValue(
          mode === 'proxy' ? { proxyUrl: `http://proxy.preview.test:${gatewayAddress.port}` } : {}
        );
        const lookup = (
          _hostname: string,
          options: dns.LookupOptions,
          callback: (
            error: NodeJS.ErrnoException | null,
            addresses: dns.LookupAddress[] | string,
            family?: number
          ) => void
        ) => {
          const addresses = [
            { address: '::1', family: 6 },
            { address: '127.0.0.1', family: 4 },
          ];
          if (options.all) callback(null, addresses);
          else callback(null, '::1', 6);
        };
        vi.spyOn(dns, 'lookup').mockImplementation(lookup as typeof dns.lookup);
        const response = await transport.fetch(`http://origin.preview.test:${address.port}/`);
        expect(await response.text()).toBe('reachable via IPv4');
        expect(userAgent).toBe(`lody-cli/${version} (oneshot)`);
        expect(tunnelEstablished).toBe(mode === 'proxy');
      } finally {
        await transport.close();
        for (const socket of sockets) socket.destroy();
        await Promise.all(
          [origin, gateway].map(
            (server) => new Promise<void>((resolve) => server.close(() => resolve()))
          )
        );
        vi.restoreAllMocks();
        setDefaultAutoSelectFamily(originalSelection);
        await logger.close();
      }
    }
  );
});
