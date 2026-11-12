import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { runAcp } from 'acp-extension-claude';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function normalizeClaudeConfigDirEnv(raw: string | undefined): void {
  if (raw === undefined) return;
  const trimmed = raw.trim();
  if (!trimmed) {
    delete process.env.CLAUDE_CONFIG_DIR;
    return;
  }
  const home = process.env.HOME?.trim() || homedir();
  let expanded = trimmed;
  if (expanded === '~' || expanded === '$HOME' || expanded === '${HOME}') {
    expanded = home;
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = join(home, expanded.slice(2));
  } else if (expanded.startsWith('$HOME/') || expanded.startsWith('$HOME\\')) {
    expanded = join(home, expanded.slice('$HOME/'.length));
  } else if (expanded.startsWith('${HOME}/') || expanded.startsWith('${HOME}\\')) {
    expanded = join(home, expanded.slice('${HOME}/'.length));
  }
  process.env.CLAUDE_CONFIG_DIR = resolve(expanded);
}

if (!process.env.CLAUDE_CODE_EXECUTABLE?.trim()) {
  console.error('CLAUDE_CODE_EXECUTABLE is required for the bundled Claude ACP adapter.');
  process.exit(1);
}

normalizeClaudeConfigDirEnv(process.env.CLAUDE_CONFIG_DIR);

const policy = await resolveSettings({ settingSources: [] });
for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
  process.env[key] = value;
}

normalizeClaudeConfigDirEnv(process.env.CLAUDE_CONFIG_DIR);

// ACP uses stdout for protocol messages. Keep diagnostics on stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const { connection, agent } = runAcp();

async function shutdown() {
  await agent.dispose().catch((error: unknown) => {
    console.error('Error during cleanup:', error);
  });
  process.exit(0);
}

void connection.closed.then(() => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
process.stdin.resume();
