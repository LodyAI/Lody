import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Check only for a credential file, without reading its contents. */
export function hasBuiltinAgentCredentials(
  type: 'kimi' | 'grok',
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const directory =
    type === 'kimi'
      ? env.KIMI_CODE_HOME || join(homeDir, '.kimi-code')
      : env.GROK_HOME || join(homeDir, '.grok');
  const file =
    type === 'kimi'
      ? join(directory, 'credentials', 'kimi-code.json')
      : join(directory, 'auth.json');
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
