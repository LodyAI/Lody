import { installAcpAdapterHttpProxySupport } from './utils/acp-http-proxy';

delete process.env.ELECTRON_RUN_AS_NODE;

if (!process.env.CODEX_PATH?.trim()) {
  console.error('CODEX_PATH is required for the bundled Codex ACP adapter.');
  process.exit(1);
}

installAcpAdapterHttpProxySupport();

await import('acp-extension-codex');

export {};
