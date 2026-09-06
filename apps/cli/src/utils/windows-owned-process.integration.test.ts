import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { spawnWindowsOwnedProcess } from './windows-owned-process';

const suite = process.platform === 'win32' ? describe : describe.skip;
suite('Windows owned launcher integration', () => {
  let directory: string;
  let launcherPath: string;
  let supervisorPath: string;
  let target: string;
  beforeAll(async () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'lody-owned-launch-'));
    launcherPath = path.join(directory, 'launcher.cjs');
    supervisorPath = path.join(directory, `windows-process-supervisor-win32-${process.arch}.exe`);
    const compiled = spawnSync(
      process.execPath,
      ['scripts/build-windows-process-supervisor.mjs', '--out-dir', directory],
      { encoding: 'utf8', windowsHide: true }
    );
    if (compiled.status !== 0) throw new Error('Native supervisor test build failed');
    await build({
      entryPoints: ['src/windows-process-launcher.ts'],
      outfile: launcherPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    target = path.join(directory, 'target with spaces.cjs');
    writeFileSync(
      target,
      `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input,mode:process.env.ELECTRON_RUN_AS_NODE??null}));process.stderr.write('target stderr');process.exitCode=7;});`
    );
  }, 30_000);
  afterAll(() => {
    if (
      directory &&
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('lody-owned-launch-')
    )
      rmSync(directory, { recursive: true, force: true });
  });
  async function run(command: string, args: string[], mode?: string) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (mode !== undefined) env.ELECTRON_RUN_AS_NODE = mode;
    const child = spawnWindowsOwnedProcess(
      command,
      args,
      { cwd: directory, env, stdio: 'pipe' },
      { launcherPath, supervisorPath }
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin?.end('stdin snow 雪');
    const code = await closed;
    return { code, stdout, stderr };
  }
  it('preserves native argv, pipes, exit code and target environment', async () => {
    const args = ['space value', '雪', '& echo injected', 'quote"value'];
    const result = await run(process.execPath, [target, ...args]);
    expect(result.code).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args, input: 'stdin snow 雪', mode: null });
    expect(result.stderr).toBe('target stderr');
  }, 15_000);
  it('preserves cmd launcher argument escaping and existing Node mode', async () => {
    const cmd = path.join(directory, 'target command.cmd');
    writeFileSync(cmd, `@"${process.execPath}" "${target}" %*\r\n`);
    const args = ['space value', '雪', '& echo injected'];
    const result = await run(cmd, args, '1');
    expect(result.code).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args, input: 'stdin snow 雪', mode: '1' });
    expect(result.stderr).toBe('target stderr');
  }, 15_000);
  it('reports target spawn failure without unowned fallback', async () => {
    const result = await run(path.join(directory, 'missing-target.exe'), []);
    expect(result.code).toBe(125);
  }, 15_000);
});
