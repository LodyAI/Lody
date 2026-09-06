import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { runAcp } from 'acp-extension-claude';
import { scrubManagedClaudeAccountEnv } from './agent/claude-env-conflict';
import { guardManagedClaudeAdapter } from './agent/managed-claude-adapter';
import { assertManagedClaudeSettingsSafe } from './agent/managed-claude-settings';

if (!process.env.CLAUDE_CODE_EXECUTABLE?.trim()) {
  console.error('CLAUDE_CODE_EXECUTABLE is required for the bundled Claude ACP adapter.');
  process.exit(1);
}

const accountConfigDir = process.env.LODY_ACCOUNT_PROFILE_ID
  ? process.env.CLAUDE_CONFIG_DIR
  : undefined;
if (process.argv.includes('--lody-check-managed-settings')) {
  try {
    if (!accountConfigDir) throw new Error('Managed account required.');
    await assertManagedClaudeSettingsSafe(process.cwd());
    process.exit(0);
  } catch {
    console.error('Claude settings conflict with the selected managed account.');
    process.exit(1);
  }
}
const policy = await resolveSettings({ settingSources: [] });
for (const [key, value] of Object.entries(policy.effective.env ?? {})) {
  process.env[key] = value;
}
if (accountConfigDir !== undefined) {
  const isolated = scrubManagedClaudeAccountEnv(process.env);
  for (const key of Object.keys(process.env)) {
    if (!(key in isolated)) delete process.env[key];
  }
  process.env.CLAUDE_CONFIG_DIR = accountConfigDir;
}

// ACP uses stdout for protocol messages. Keep diagnostics on stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const { connection, agent } = runAcp();
if (accountConfigDir !== undefined) guardManagedClaudeAdapter(agent);

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
