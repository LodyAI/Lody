import { installAcpAdapterHttpProxySupport } from './utils/acp-http-proxy';

installAcpAdapterHttpProxySupport();

await import('acp-extension-grok');

export {};
