import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccountProfile, resolveAccountProfileEnv } from '../src/agent/account-profiles';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-account-platform-'));
try {
  const nativeHome = path.join(root, 'native');
  await fs.mkdir(nativeHome);
  const original = '{"synthetic":"native-credential"}';
  await fs.writeFile(path.join(nativeHome, 'auth.json'), original);
  const profilesRoot = path.join(root, 'profiles');
  for (const agentType of ['codex', 'claude']) {
    const input = { cliType: 'builtin' as const, agentType, profilesRoot };
    const base = { CODEX_HOME: nativeHome, CLAUDE_CONFIG_DIR: nativeHome };
    assert.equal(await resolveAccountProfileEnv({ ...input, env: base }), base);
    assert.equal(
      await resolveAccountProfileEnv({ ...input, env: base, accountProfileId: 'system-default' }),
      base
    );
    const first = await createAccountProfile({ ...input, label: 'First', operationId: 'first' });
    const second = await createAccountProfile({ ...input, label: 'Second', operationId: 'second' });
    const firstEnv = await resolveAccountProfileEnv({
      ...input,
      env: base,
      accountProfileId: first.accountProfileId,
    });
    const secondEnv = await resolveAccountProfileEnv({
      ...input,
      env: base,
      accountProfileId: second.accountProfileId,
    });
    const key = agentType === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const firstHome = firstEnv[key];
    const secondHome = secondEnv[key];
    assert.ok(firstHome && secondHome);
    assert.notEqual(firstHome, nativeHome);
    assert.notEqual(firstHome, secondHome);
    assert.equal(
      path.dirname(firstHome),
      path.join(profilesRoot, agentType, first.accountProfileId)
    );
    await fs.writeFile(path.join(firstHome, 'synthetic-auth'), 'first');
    await fs.writeFile(path.join(secondHome, 'synthetic-auth'), 'second');
    const replay = await createAccountProfile({ ...input, label: 'First', operationId: 'first' });
    assert.equal(replay.accountProfileId, first.accountProfileId);
    assert.equal(await fs.readFile(path.join(firstHome, 'synthetic-auth'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(secondHome, 'synthetic-auth'), 'utf8'), 'second');
    assert.equal(await fs.readFile(path.join(nativeHome, 'auth.json'), 'utf8'), original);
    assert.deepEqual(base, { CODEX_HOME: nativeHome, CLAUDE_CONFIG_DIR: nativeHome });
  }
  console.log(
    `PASS ${process.platform}: System Default unchanged; Codex/Claude homes isolated; creation replay preserves files.`
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
