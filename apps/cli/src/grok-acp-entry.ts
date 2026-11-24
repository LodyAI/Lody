import { installAcpAdapterHttpProxySupport } from './utils/acp-http-proxy';

delete process.env.ELECTRON_RUN_AS_NODE;

installAcpAdapterHttpProxySupport();

await import('acp-extension-grok');

export {};
