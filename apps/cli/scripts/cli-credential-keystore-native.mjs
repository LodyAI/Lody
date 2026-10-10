/**
 * Writes, reads, and deletes one CLI credential-store entry in separate
 * processes. macOS and Windows must complete the round trip. Linux may skip
 * when Secret Service cannot be opened and CLI_KEYSTORE_ALLOW_UNAVAILABLE=1.
 *
 *   node --experimental-strip-types apps/cli/scripts/cli-credential-keystore-native.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliTokenKeyringIdentity } from '../src/lib/cli-credential-keyring-identity.ts';

const scriptPath = fileURLToPath(import.meta.url);
const CHILD_TIMEOUT_MS = 20_000;

function openEntry(dataDir) {
  const modulePath = process.env.CLI_KEYRING_MODULE;
  if (!modulePath) {
    throw new Error('CLI_KEYRING_MODULE is not set');
  }
  const loaded = createRequire(scriptPath)(modulePath);
  if (typeof loaded.Entry !== 'function') {
    throw new Error('OS credential store binding is unavailable');
  }
  const identity = cliTokenKeyringIdentity(dataDir);
  return new loaded.Entry(identity.service, identity.username, identity.options);
}

function installKeyring() {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = manifest.dependencies['@napi-rs/keyring'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-keyring-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const spawnOptions = {
    cwd: dir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  };
  const init = spawnSync(npm, ['init', '-y'], spawnOptions);
  if (init.status !== 0) {
    throw new Error(init.stderr || init.stdout || 'npm init failed');
  }
  const installed = spawnSync(
    npm,
    ['install', '--save-exact', `@napi-rs/keyring@${version}`],
    spawnOptions
  );
  if (installed.status !== 0) {
    throw new Error(installed.stderr || installed.stdout || 'npm install failed');
  }
  return path.join(dir, 'node_modules', '@napi-rs/keyring');
}

function linuxBusLooksAvailable() {
  if (process.env.DBUS_SESSION_BUS_ADDRESS?.trim()) return true;
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir && fs.existsSync(path.join(runtimeDir, 'bus'))) return true;
  if (typeof process.getuid === 'function' && fs.existsSync(`/run/user/${process.getuid()}/bus`)) {
    return true;
  }
  return false;
}

function allowUnavailable() {
  return process.env.CLI_KEYSTORE_ALLOW_UNAVAILABLE === '1';
}

function runChild(args, env) {
  return spawnSync(process.execPath, [...process.execArgv, scriptPath, ...args], {
    encoding: 'utf8',
    env,
    timeout: CHILD_TIMEOUT_MS,
  });
}

function childFailed(result) {
  if (result.error) return result.error.message;
  if (result.status !== 0) return result.stderr || result.stdout || `exit ${result.status}`;
  return null;
}

function skip(message) {
  process.stdout.write(`native-keystore: skipped\n${message}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [command, dataDir, token] = process.argv.slice(2);

if (command === 'write' || command === 'read' || command === 'delete') {
  try {
    const entry = openEntry(dataDir);
    if (command === 'write') {
      entry.setPassword(token);
      process.stdout.write(`wrote ${process.pid}\n`);
    } else if (command === 'read') {
      const value = entry.getPassword();
      if (typeof value === 'string' && value.length > 0) {
        process.stdout.write(`value:${value} pid:${process.pid}\n`);
      } else {
        process.stdout.write(`missing pid:${process.pid}\n`);
      }
    } else {
      entry.deleteCredential();
      process.stdout.write(`deleted ${process.pid}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command === 'write' && allowUnavailable()) {
      process.stdout.write(`skipped: ${message}\n`);
      process.exit(0);
    }
    process.stderr.write(`${error instanceof Error ? error.stack : message}\n`);
    process.exit(1);
  }
} else if (command === undefined) {
  if (process.platform === 'linux' && !linuxBusLooksAvailable()) {
    if (allowUnavailable()) {
      skip('Linux Secret Service is not available');
    }
    fail('Linux Secret Service is not available');
  }

  const modulePath = installKeyring();
  const env = { ...process.env, CLI_KEYRING_MODULE: modulePath };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-cli-keystore-native-'));
  const secret = `native-${process.pid}-${Date.now()}`;
  let needsDelete = false;
  try {
    const wrote = runChild(['write', dir, secret], env);
    const writeError = childFailed(wrote);
    if (writeError) {
      if (allowUnavailable()) skip(writeError);
      fail(writeError);
    }
    const writeOut = wrote.stdout.trim();
    if (writeOut.startsWith('skipped:')) {
      skip(writeOut);
    }
    const writePid = Number(writeOut.slice('wrote '.length));
    if (!writeOut.startsWith('wrote ') || writePid === process.pid) {
      fail('The write did not run in a separate process');
    }
    needsDelete = true;

    const read = runChild(['read', dir], env);
    const readError = childFailed(read);
    if (readError) fail(readError);
    const matched = /^value:(.*) pid:(\d+)$/u.exec(read.stdout.trim());
    const readPid = matched ? Number(matched[2]) : Number.NaN;
    if (!matched || matched[1] !== secret || readPid === process.pid || readPid === writePid) {
      fail('A separate process did not return the written token');
    }

    const deleted = runChild(['delete', dir], env);
    const deleteError = childFailed(deleted);
    if (deleteError) fail(deleteError);
    needsDelete = false;

    const after = runChild(['read', dir], env);
    const afterError = childFailed(after);
    if (afterError) fail(afterError);
    if (!after.stdout.trim().startsWith('missing ')) {
      fail('The credential was still present after delete');
    }
    process.stdout.write('native-keystore: ok\n');
  } finally {
    if (needsDelete) {
      runChild(['delete', dir], env);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  fail(`Unknown command ${command}`);
}
