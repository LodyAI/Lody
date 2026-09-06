import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import {
  assertManagedClaudeSettingsSafe,
  assertManagedClaudeSettingsValuesSafe,
} from './managed-claude-settings';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it('uses the real SDK cascade for isolated user, project, local and policy settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-claude-settings-'));
  roots.push(root);
  const home = path.join(root, 'profile');
  const project = path.join(root, 'project');
  await fs.mkdir(home);
  await fs.mkdir(path.join(project, '.claude'), { recursive: true });
  vi.stubEnv('CLAUDE_CONFIG_DIR', home);
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus' }));
  await fs.writeFile(
    path.join(project, '.claude', 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'synthetic-project-key' },
    })
  );
  await fs.writeFile(
    path.join(project, '.claude', 'settings.local.json'),
    JSON.stringify({
      apiKeyHelper: 'echo synthetic-helper',
    })
  );
  const resolved = await resolveSettings({
    cwd: project,
    settingSources: ['user', 'project', 'local'],
  });
  expect(resolved.effective.model).toBe('opus');
  expect(resolved.effective.env?.ANTHROPIC_API_KEY).toBe('synthetic-project-key');
  expect(resolved.effective.apiKeyHelper).toBe('echo synthetic-helper');
  await expect(assertManagedClaudeSettingsSafe(project)).rejects.toThrow('override authentication');
  const policy = await resolveSettings({
    cwd: home,
    settingSources: [],
    serverManagedSettings: { env: { ANTHROPIC_AUTH_TOKEN: 'synthetic-policy-token' } },
  });
  expect(policy.effective.env?.ANTHROPIC_AUTH_TOKEN).toBe('synthetic-policy-token');
  expect(() => assertManagedClaudeSettingsValuesSafe(policy.effective)).toThrow(
    'override authentication'
  );
});
