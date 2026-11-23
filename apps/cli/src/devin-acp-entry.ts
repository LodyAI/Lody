import { installAcpAdapterHttpProxySupport } from './utils/acp-http-proxy';

installAcpAdapterHttpProxySupport();

await import('acp-extension-devin/dist/index.js');

export {};
