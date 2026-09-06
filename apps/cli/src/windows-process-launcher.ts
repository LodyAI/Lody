import spawn from 'cross-spawn';

// This launcher runs inside the native supervisor's job before spawning any target.
const env = { ...process.env };
const marker = env.LODY_WINDOWS_TARGET_NODE_MODE;
delete env.LODY_WINDOWS_TARGET_NODE_MODE;
if (marker !== undefined) {
  const original: unknown = JSON.parse(marker);
  if (original === null) delete env.ELECTRON_RUN_AS_NODE;
  else if (typeof original === 'string') env.ELECTRON_RUN_AS_NODE = original;
  else throw new Error('Invalid owned-process environment');
}
const command = process.argv[2];
if (!command) throw new Error('Owned-process target command is missing');
const child = spawn(command, process.argv.slice(3), { stdio: 'inherit', env, windowsHide: true });
child.on('error', () => {
  process.exitCode = 125;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 125;
});
