if (!process.env.CODEX_PATH?.trim()) {
  console.error('CODEX_PATH is required for the bundled Codex ACP adapter.');
  process.exit(1);
}

await import('acp-extension-codex/dist/lody.js');

export {};
