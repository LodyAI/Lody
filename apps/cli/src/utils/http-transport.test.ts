import dns from 'node:dns';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createCliHttpTransport, resolveCliHttpTransportConfig } from './http-transport';
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
  it.each(['direct', 'proxy'])(
    'reaches IPv4 after an unavailable IPv6 address through %s transport',
    async (mode) => {
      const originalSelection = getDefaultAutoSelectFamily();
      setDefaultAutoSelectFamily(false);
      const logger = createLogger({ transports: 'console', level: 'silent' });
      const origin = createServer((_request, response) => response.end('reachable via IPv4'));
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
  it('enables the custom dispatcher and uses HTTP/1 by default', () => {
    const config = resolveCliHttpTransportConfig(envOf({}));

    expect(config.enabled).toBe(true);
    expect(config.allowH2).toBe(false);
    expect(config.connectTimeoutMs).toBe(15_000);
    expect(config.maxConcurrentStreams).toBe(100);
    expect(config.proxyEnvPresent).toBe(false);
  });

  it('allows HTTP/2 to be enabled without disabling proxy-aware transport', () => {
    const config = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP2: '1',
        HTTPS_PROXY: 'http://proxy.example.com:8080',
      })
    );

    expect(config.enabled).toBe(true);
    expect(config.allowH2).toBe(true);
    expect(config.proxyEnvPresent).toBe(true);
  });

  it('can fall back to the Node default dispatcher explicitly', () => {
    const config = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP_TRANSPORT: 'default',
      })
    );

    expect(config.enabled).toBe(false);
  });

  it('parses bounded numeric tuning values and ignores invalid values', () => {
    const config = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP_CONNECT_TIMEOUT_MS: '30000',
        LODY_HTTP2_MAX_CONCURRENT_STREAMS: '256',
      })
    );
    const fallbackConfig = resolveCliHttpTransportConfig(
      envOf({
        LODY_HTTP_CONNECT_TIMEOUT_MS: '-1',
        LODY_HTTP2_MAX_CONCURRENT_STREAMS: 'not-a-number',
      })
    );

    expect(config.connectTimeoutMs).toBe(30_000);
    expect(config.maxConcurrentStreams).toBe(256);
    expect(fallbackConfig.connectTimeoutMs).toBe(15_000);
    expect(fallbackConfig.maxConcurrentStreams).toBe(100);
  });
});
