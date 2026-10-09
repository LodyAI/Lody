import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createGuestButtons } from './guest-buttons';

it('keeps one acknowledged guest service, binds its device and joins shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lody-button-test-'));
  const executable = join(dir, 'xcrun');
  const record = join(dir, 'record');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'); const record=${JSON.stringify(record)};
fs.appendFileSync(record,JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[2]==='--sdk')process.exit(0);
process.on('exit',()=>{fs.appendFileSync(record,'closed\\n')});
console.log('ready');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
fs.appendFileSync(record,line+'\\n');console.log(line.split(' ')[0]+' ok');});
`,
    { mode: 0o700 }
  );
  const abort = new AbortController();
  const service = createGuestButtons(abort.signal, executable);
  try {
    await service.prepare('device');
    await service.press('device', 'home');
    await service.press('device', 'app-switcher');
    await expect(service.press('other', 'lock')).rejects.toThrow();
    await service.press('device', 'lock');
    abort.abort();
    await service.close();
    const lines = (await readFile(record, 'utf8')).trim().split('\n');
    expect(lines.slice(2)).toEqual(['1 home', '2 app-switcher', '3 lock', 'closed']);
    const compile = JSON.parse(lines[0] ?? '[]') as string[];
    expect(compile.slice(0, 4)).toEqual(['--sdk', 'iphonesimulator', 'clang', '-arch']);
    const spawn = JSON.parse(lines[1] ?? '[]') as string[];
    expect(spawn.slice(0, 3)).toEqual(['simctl', 'spawn', 'device']);
    await expect(readFile(spawn[3] ?? '')).rejects.toThrow();
    await expect(service.press('device', 'home')).rejects.toThrow();
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['error', 'wrong-id', 'exit'])(
  'rejects %s without replaying an uncertain press',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'lody-button-test-'));
    const executable = join(dir, 'xcrun');
    const record = join(dir, 'record');
    await writeFile(
      executable,
      `#!${process.execPath}
if(process.argv[2]==='--sdk')process.exit(0);
console.log('ready');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
require('node:fs').appendFileSync(${JSON.stringify(record)},line+'\\n');
if(${JSON.stringify(mode)}==='exit')process.exit(0);
console.log(${JSON.stringify(mode)}==='error'?'1 error':'2 ok');});
`,
      { mode: 0o700 }
    );
    const service = createGuestButtons(new AbortController().signal, executable);
    try {
      await expect(service.press('device', 'home')).rejects.toThrow();
      await expect(service.press('device', 'home')).rejects.toThrow();
      expect(await readFile(record, 'utf8')).toBe('1 home\n');
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

it('joins the owned group when its parent exits before a descendant with separate stdio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lody-button-descendant-'));
  const executable = join(dir, 'xcrun');
  const record = join(dir, 'pid');
  await writeFile(
    executable,
    `#!${process.execPath}
if(process.argv[2]==='--sdk')process.exit(0);
const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
require('node:fs').writeFileSync(${JSON.stringify(record)},String(child.pid));
console.log('ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));
`,
    { mode: 0o700 }
  );
  const service = createGuestButtons(new AbortController().signal, executable);
  let pid: number | undefined;
  try {
    await service.prepare('device');
    pid = Number(await readFile(record, 'utf8'));
    await service.close();
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already joined. */
      }
    }
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
