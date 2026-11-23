import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http, { createServer } from 'node:http';
import https from 'node:https';
import { connect, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import {
  MockAgent,
  Pool,
  getGlobalDispatcher,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from 'undici';
import { version } from '@/pkg';
import { describe, expect, it, vi } from 'vitest';
import {
  installAcpAdapterHttpProxySupport,
  resetAcpAdapterHttpProxySupportForTests,
} from './acp-http-proxy';
import {
  createCliHttpTransport,
  resolveCliHttpTransportConfig,
  installCliHttpGlobalDispatcher,
  getCliHttpFetch,
  resetCliHttpTransportForTests,
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

  it('routes globalThis.fetch (including native Request) through ProxyAgent and preserves caller dispatcher', async () => {
    const logger = createLogger({ transports: 'console', level: 'silent' });
    let lastRequest: { method?: string; body: string; header?: string } | undefined;
    const origin = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        lastRequest = {
          method: request.method,
          body: Buffer.concat(chunks).toString('utf8'),
          header:
            typeof request.headers['x-native-req'] === 'string'
              ? request.headers['x-native-req']
              : undefined,
        };
        response.end('proxied-global-fetch');
      });
    });
    const gateway = createServer();
    const sockets = new Set<Duplex>();
    const tunneledTargets: string[] = [];
    const track = (socket: Duplex) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    };
    const previousHttpsProxy = process.env.HTTPS_PROXY;
    const previousHttpProxy = process.env.HTTP_PROXY;
    const previousNoProxy = process.env.NO_PROXY;
    const previousLowerNoProxy = process.env.no_proxy;
    let directPool: Pool | undefined;
    try {
      origin.listen(0, '127.0.0.1');
      await once(origin, 'listening');
      const originAddress = origin.address();
      if (!originAddress || typeof originAddress === 'string')
        throw new Error('missing origin port');
      gateway.on('connect', (request, socket, head) => {
        tunneledTargets.push(request.url ?? '');
        const upstream = connect(originAddress.port, '127.0.0.1');
        track(upstream);
        track(socket);
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        upstream.on('connect', () => {
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

      process.env.HTTP_PROXY = `http://127.0.0.1:${gatewayAddress.port}`;
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      installCliHttpGlobalDispatcher({ logger });
      const response = await globalThis.fetch(`http://127.0.0.1:${originAddress.port}/hello`);
      expect(response).toBeInstanceOf(globalThis.Response);
      expect(await response.text()).toBe('proxied-global-fetch');
      expect(tunneledTargets).toEqual([`127.0.0.1:${originAddress.port}`]);

      const nativeRequest = new globalThis.Request(
        `http://127.0.0.1:${originAddress.port}/native-req`,
        {
          method: 'POST',
          headers: { 'x-native-req': 'yes' },
          body: 'native-payload',
        }
      );
      const nativeResponse = await globalThis.fetch(nativeRequest);
      expect(nativeResponse).toBeInstanceOf(globalThis.Response);
      expect(await nativeResponse.text()).toBe('proxied-global-fetch');
      expect(lastRequest).toEqual({
        method: 'POST',
        body: 'native-payload',
        header: 'yes',
      });
      expect(tunneledTargets).toEqual([
        `127.0.0.1:${originAddress.port}`,
        `127.0.0.1:${originAddress.port}`,
      ]);

      directPool = new Pool(`http://127.0.0.1:${originAddress.port}`);
      const callerDispatcherResponse = await globalThis.fetch(
        `http://127.0.0.1:${originAddress.port}/direct-pool`,
        { dispatcher: directPool } as RequestInit
      );
      expect(callerDispatcherResponse).toBeInstanceOf(globalThis.Response);
      expect(await callerDispatcherResponse.text()).toBe('proxied-global-fetch');
      expect(tunneledTargets).toHaveLength(2);
    } finally {
      await directPool?.close();
      await resetCliHttpTransportForTests();
      if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousHttpsProxy;
      if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previousHttpProxy;
      if (previousNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previousNoProxy;
      if (previousLowerNoProxy === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = previousLowerNoProxy;
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [origin, gateway].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve()))
        )
      );
      await logger.close();
    }
  });
});

describe('installAcpAdapterHttpProxySupport', () => {
  it('leaves globalThis.fetch and globalAgents untouched when no proxy env is configured', async () => {
    const previousFetch = globalThis.fetch;
    const previousHttpAddRequest = http.globalAgent.addRequest;
    const previousHttpsAddRequest = https.globalAgent.addRequest;
    try {
      installAcpAdapterHttpProxySupport({ env: {} });
      expect(globalThis.fetch).toBe(previousFetch);
      expect(http.globalAgent.addRequest).toBe(previousHttpAddRequest);
      expect(https.globalAgent.addRequest).toBe(previousHttpsAddRequest);
    } finally {
      await resetAcpAdapterHttpProxySupportForTests();
    }
  });

  it('routes node:https.request, node:http.request, and globalThis.fetch through env proxies while preserving User-Agent and NO_PROXY', async () => {
    const certDir = mkdtempSync(join(tmpdir(), 'lody-acp-proxy-test-'));
    const keyPath = join(certDir, 'key.pem');
    const certPath = join(certDir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' }
    );
    const certPem = readFileSync(certPath);
    const tlsOrigin = https.createServer(
      { key: readFileSync(keyPath), cert: certPem },
      (request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            path: request.url,
            userAgent: request.headers['user-agent'],
          })
        );
      }
    );
    const httpOrigin = createServer((request, response) => {
      response.end(request.headers['user-agent'] ?? '');
    });
    const proxyServer = createServer();
    const sockets = new Set<Duplex>();
    const tunneledTargets: string[] = [];
    const track = (socket: Duplex) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    };

    const savedEnv = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      all_proxy: process.env.all_proxy,
      no_proxy: process.env.no_proxy,
    };

    try {
      tlsOrigin.listen(0, '127.0.0.1');
      httpOrigin.listen(0, '127.0.0.1');
      await Promise.all([once(tlsOrigin, 'listening'), once(httpOrigin, 'listening')]);
      const tlsAddress = tlsOrigin.address();
      const httpAddress = httpOrigin.address();
      if (
        !tlsAddress ||
        typeof tlsAddress === 'string' ||
        !httpAddress ||
        typeof httpAddress === 'string'
      ) {
        throw new Error('missing origin port');
      }

      proxyServer.on('connect', (request, socket, head) => {
        tunneledTargets.push(request.url ?? '');
        const [host, portStr] = (request.url ?? '').split(':');
        const upstream = connect(Number(portStr), host);
        track(upstream);
        track(socket);
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        upstream.on('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
      });
      proxyServer.listen(0, '127.0.0.1');
      await once(proxyServer, 'listening');
      const proxyAddress = proxyServer.address();
      if (!proxyAddress || typeof proxyAddress === 'string') {
        throw new Error('missing proxy port');
      }

      for (const key of Object.keys(savedEnv) as Array<keyof typeof savedEnv>) {
        delete process.env[key];
      }

      const warnings: string[] = [];
      process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
      installAcpAdapterHttpProxySupport({ onWarn: (msg) => warnings.push(msg) });

      const httpsBody = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port: tlsAddress.port,
            path: '/api/oauth/usage',
            method: 'GET',
            headers: { 'User-Agent': 'claude-hud/1.0' },
            ca: certPem,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(JSON.parse(httpsBody)).toEqual({
        path: '/api/oauth/usage',
        userAgent: 'claude-hud/1.0',
      });
      expect(tunneledTargets).toContain(`127.0.0.1:${tlsAddress.port}`);

      const httpBody = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: httpAddress.port,
            path: '/v1/models',
            method: 'GET',
            headers: { 'User-Agent': 'custom-adapter/2.0' },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => resolve(data));
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(httpBody).toBe('custom-adapter/2.0');
      expect(tunneledTargets).toContain(`127.0.0.1:${httpAddress.port}`);

      const fetchRes = await globalThis.fetch(
        new globalThis.Request(`http://127.0.0.1:${httpAddress.port}/models`, {
          headers: { 'User-Agent': 'gateway-fetcher/1.0' },
        })
      );
      expect(fetchRes).toBeInstanceOf(globalThis.Response);
      expect(await fetchRes.text()).toBe('gateway-fetcher/1.0');
      expect(
        tunneledTargets.filter((target) => target === `127.0.0.1:${httpAddress.port}`)
      ).toHaveLength(2);

      process.env.NO_PROXY = '127.0.0.1,localhost';
      const countBeforeBypass = tunneledTargets.length;
      const directFetch = await globalThis.fetch(`http://localhost:${httpAddress.port}/direct`);
      expect(directFetch.ok).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: httpAddress.port,
            path: '/direct',
            method: 'GET',
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(tunneledTargets).toHaveLength(countBeforeBypass);

      delete process.env.NO_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      process.env.ALL_PROXY = 'socks5://127.0.0.1:1089';
      await resetAcpAdapterHttpProxySupportForTests();
      installAcpAdapterHttpProxySupport({ onWarn: (msg) => warnings.push(msg) });
      const socksFallback = await globalThis.fetch(`http://127.0.0.1:${httpAddress.port}/socks`);
      expect(socksFallback.ok).toBe(true);
      expect(warnings.some((w) => w.includes('ignoring unsupported proxy URL'))).toBe(true);
    } finally {
      await resetAcpAdapterHttpProxySupportForTests();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [tlsOrigin, httpOrigin, proxyServer].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve()))
        )
      );
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
