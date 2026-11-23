import { describe, expect, it } from 'vitest';
import { withLoopbackNoProxy } from '../src/proxy-env';

describe('withLoopbackNoProxy', () => {
  it('excludes loopback when the uppercase spelling is empty', () => {
    // The reported Grok shape: `no_proxy` correct, `NO_PROXY` present but
    // empty. Rust reqwest reads the uppercase one first and proxies loopback.
    const env = withLoopbackNoProxy<NodeJS.ProcessEnv>({
      HTTP_PROXY: 'http://127.0.0.1:1087',
      no_proxy: 'localhost,127.0.0.1,::1',
      NO_PROXY: '',
    });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });

  it('adds loopback when a proxy is set with no bypass at all', () => {
    const env = withLoopbackNoProxy<NodeJS.ProcessEnv>({ ALL_PROXY: 'socks5://127.0.0.1:1080' });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });

  it('keeps a corporate bypass list and mirrors it to both spellings', () => {
    const env = withLoopbackNoProxy<NodeJS.ProcessEnv>({
      https_proxy: 'http://proxy.corp:8080',
      NO_PROXY: 'corp.internal',
    });
    expect(env.NO_PROXY).toBe('corp.internal,localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('corp.internal,localhost,127.0.0.1,::1');
  });

  it('bypasses loopback even when the environment carries no proxy variable', () => {
    // The agent may apply a proxy Lody never sees (its own settings file, or
    // the OS proxy read by its HTTP client). Its requests to the loopback MCP
    // host must still go direct, or the proxy answers in the host's place.
    const env = withLoopbackNoProxy<NodeJS.ProcessEnv>({ PATH: '/usr/bin' });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });
});
