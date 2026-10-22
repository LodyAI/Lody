import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, link, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { Cause, Effect, Result } from 'effect';
import { runCommandOk, squashProcessFailure, type NodeProcessApi } from '@lody/shared/node/process';
import { platformLayer } from '../../platform/process-options';
import {
  makeNodeE2eeCustody,
  NodeE2eeCustodyError,
  type KekWrapper,
} from '@lody/e2ee-core/adapters/node-custody';

/** Native boundary used by the machine-only custody; missing and failed reads stay distinct. */
export interface MachineKeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(value: string): Promise<void>;
  deleteCredential(): Promise<unknown>;
}
/** The entry factory is lazy: ordinary daemon startup never accesses a keyring. */
export type MachineKeyring = (account: string) => Promise<MachineKeyringEntry>;
// Native keyring prompts cannot be cancelled in-process. The official process
// owner terminates and joins this helper before a timeout can select file custody.
const keyringHelper = `
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { moduleUrl, account, operation, value } = JSON.parse(input);
  const loaded = await import(moduleUrl);
  const { AsyncEntry } = loaded.default ?? loaded;
  const entry = new AsyncEntry('Lody E2EE Machine Custody', account, { linux: { store: 'secret-service' } });
  let result = null;
  if (operation === 'get') result = (await entry.getPassword()) ?? null;
  else if (operation === 'set') await entry.setPassword(value);
  else if (operation === 'delete') await entry.deleteCredential();
  else throw new Error('invalid');
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stderr.write('e2ee_keyring_unavailable');
  process.exitCode = 1;
}
`;
/** One bounded native operation; caller supplies the official process Layer. */
const machineKeyringOperation = (
  account: string,
  operation: 'get' | 'set' | 'delete',
  value?: string
) =>
  Effect.gen(function* () {
    const moduleUrl = yield* Effect.try({
      try: () => pathToFileURL(createRequire(import.meta.url).resolve('@napi-rs/keyring')).href,
      catch: () => failure('unavailable'),
    });
    const output = yield* runCommandOk({
      command: process.execPath,
      args: ['--input-type=module', '-e', keyringHelper],
      env: { ...process.env },
      input: JSON.stringify({ moduleUrl, account, operation, value }),
      timeout: 10_000,
      maxOutputBytes: 8192,
    }).pipe(Effect.catchCause(processFailure));
    return yield* Effect.try({
      try: () => {
        const result: unknown = JSON.parse(output.stdout.toString('utf8'));
        if (result !== null && typeof result !== 'string') throw failure('corrupt');
        return result === null ? undefined : result;
      },
      catch: () => failure('corrupt'),
    });
  });
const failure = (code: NodeE2eeCustodyError['code']) => new NodeE2eeCustodyError({ code });
// Effect 4.0.2's mapError/result can discard mixed Fail+Die causes. An unresolved
// process tree is a recovery owner, never an ordinary keyring-unavailable result.
const processFailure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(Cause.isDieReason)
    ? Effect.die(squashProcessFailure(cause))
    : cause.reasons.some(Cause.isInterruptReason)
      ? Effect.interrupt
      : Effect.fail(failure('unavailable'));

const native = <A>(work: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: work,
      catch: (error) => (error instanceof NodeE2eeCustodyError ? error : failure('unavailable')),
    })
  );
// Windows mode bits do not restrict a DACL. Protect a newly created directory
// before publishing secrets; verify existing ACLs without silently repairing them.
function windowsAcl(path: string, create = false) {
  if (process.platform !== 'win32') return Effect.void;
  const encoded = Buffer.from(path, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
${
  create
    ? `
$a = New-Object Security.AccessControl.DirectorySecurity
$a.SetOwner($sid)
$a.SetAccessRuleProtection($true, $false)
$r = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$a.AddAccessRule($r)
Set-Acl -LiteralPath $p -AclObject $a`
    : ''
}
$paths = @($p) + @(Get-ChildItem -LiteralPath $p -Force | ForEach-Object { $_.FullName })
foreach ($path in $paths) {
if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'link' }
$a = Get-Acl -LiteralPath $path
if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
foreach ($r in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne $sid.Value) { throw 'access' }
}
}
`;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) return Effect.fail(failure('unavailable'));
  return runCommandOk({
    command: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    maxOutputBytes: 1024,
    timeout: 15_000,
  }).pipe(Effect.provide(platformLayer({})), Effect.asVoid, Effect.catchCause(processFailure));
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function publish(path: string, value: string) {
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
    await file.close();
    await link(temporary, path);
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
async function privatePath(path: string, directory = false) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw failure('corrupt');
}
async function readPrivate(path: string) {
  await privatePath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      info.size < 1 ||
      info.size > 8192 ||
      (process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw failure('corrupt');
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** Create/open one machine workspace's custody. First creation selects protection permanently;
 * later keyring errors never select file protection. The enclosing Scope owns all private buffers.
 */
export const makeCliE2eeCustody = Effect.fn('CliE2eeCustody.open')(function* (options: {
  readonly directory: string;
  readonly keyring?: MachineKeyring;
  readonly nodeProcess?: NodeProcessApi;
}) {
  const directory = options.directory;
  if (!isAbsolute(directory)) return yield* failure('invalid-input');
  const createdDirectory = yield* native(async () => {
    const created = !(await exists(directory));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privatePath(directory, true);
    return created;
  });
  yield* windowsAcl(directory, createdDirectory);
  const lockPath = join(directory, 'selection.sqlite');
  const mutex = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const db = yield* native(async () => {
          try {
            const file = await open(lockPath, 'wx', 0o600);
            await file.close();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          await privatePath(lockPath);
          const connection = new DatabaseSync(lockPath);
          try {
            connection.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
            return connection;
          } catch (error) {
            connection.close();
            if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) return undefined;
            throw error;
          }
        });
        if (db) return db;
        if (attempt >= 600) return yield* failure('unavailable');
        // Yield the JS thread: another opener may be awaiting the native keyring.
        yield* Effect.sleep('100 millis');
      }
    }),
    (db) => Effect.sync(() => db.close())
  );
  const marker = join(directory, 'protection');
  const callKeyring = (account: string, operation: 'get' | 'set' | 'delete', value?: string) =>
    options.keyring
      ? native(async () => {
          const entry = await options.keyring!(account);
          if (operation === 'get') return entry.getPassword();
          if (operation === 'set') await entry.setPassword(value!);
          else await entry.deleteCredential();
          return undefined;
        })
      : machineKeyringOperation(account, operation, value).pipe(
          Effect.provide(platformLayer({ nodeProcess: options.nodeProcess }))
        );

  let protection: KekWrapper['protection'];
  let selected: Buffer | undefined;
  selected = yield* native(() =>
    readPrivate(marker).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    })
  );
  // Read absence without converting an existing keyring failure into creation.
  if (selected) protection = selected.toString('utf8') as KekWrapper['protection'];
  else protection = 'file';
  // The helper below preserves ENOENT while all other file failures refuse.
  if (!selected) {
    // A missing selector cannot authorize changing protection of existing originals.
    const originals = yield* native(async () =>
      (await readdir(directory)).some(
        (name) =>
          !/^selection\.sqlite(?:-journal|-wal|-shm)?$/.test(name) &&
          !/^protection\.[a-f0-9]{32}\.tmp$/.test(name)
      )
    );
    if (originals) return yield* failure('corrupt');
    const probeId = `probe:${randomBytes(16).toString('hex')}`;
    const probe = randomBytes(32).toString('hex');
    const available = yield* Effect.gen(function* () {
      const probed = yield* Effect.result(
        Effect.gen(function* () {
          yield* callKeyring(probeId, 'set', probe);
          return (yield* callKeyring(probeId, 'get')) === probe;
        })
      );
      // A process-release defect bypasses this fallback; do not start another
      // helper or publish file protection while the previous tree is unresolved.
      yield* callKeyring(probeId, 'delete').pipe(Effect.catch(() => Effect.void));
      return Result.isSuccess(probed) && probed.success;
    });
    protection = available ? 'os-keystore' : 'file';
    yield* native(() => publish(marker, protection));
  }
  if (protection !== 'file' && protection !== 'os-keystore') return yield* failure('corrupt');
  // Once a device exists, a lost KEK must preserve the remaining originals.
  const missingKek = yield* native(
    async () =>
      !(await exists(join(directory, 'kek.safe-storage'))) &&
      (await readdir(directory)).some((name) => name.endsWith('.device'))
  );
  if (missingKek) return yield* failure('corrupt');
  let key: Uint8Array | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => key?.fill(0)));
  if (protection === 'os-keystore') {
    const account = createHash('sha256').update(directory).digest('hex');
    let encoded = yield* callKeyring(account, 'get');
    if (encoded === undefined) {
      if (yield* native(() => exists(join(directory, 'kek.safe-storage'))))
        return yield* failure('unavailable');
      const original = randomBytes(32).toString('hex');
      yield* callKeyring(account, 'set', original);
      encoded = yield* callKeyring(account, 'get');
      if (encoded !== original) return yield* failure('unavailable');
    }
    if (encoded === undefined || !/^[0-9a-f]{64}$/.test(encoded)) return yield* failure('corrupt');
    key = new Uint8Array(Buffer.from(encoded, 'hex'));
  }

  const wrappingKey = key;
  if (protection === 'os-keystore' && !wrappingKey) return yield* failure('unavailable');
  const aad = new TextEncoder().encode('lody-e2ee/cli-kek-wrapper/v1\0');
  const wrapper: KekWrapper =
    protection === 'file'
      ? {
          protection,
          wrap: async (value) => Buffer.from(value, 'hex'),
          unwrap: async (blob) => {
            await privatePath(directory, true);
            await privatePath(join(directory, 'kek.safe-storage'));
            if (blob.length !== 32) throw failure('corrupt');
            return { result: Buffer.from(blob).toString('hex'), shouldReEncrypt: false };
          },
        }
      : {
          protection,
          wrap: async (value) => {
            const nonce = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', wrappingKey ?? new Uint8Array(), nonce);
            cipher.setAAD(aad);
            const plaintext = Buffer.from(value, 'hex');
            try {
              const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
              return new Uint8Array(Buffer.concat([nonce, cipher.getAuthTag(), body]));
            } finally {
              plaintext.fill(0);
            }
          },
          unwrap: async (blob) => {
            if (blob.length !== 60) throw failure('corrupt');
            const cipher = createDecipheriv(
              'aes-256-gcm',
              wrappingKey ?? new Uint8Array(),
              blob.subarray(0, 12)
            );
            cipher.setAAD(aad);
            cipher.setAuthTag(blob.subarray(12, 28));
            const plaintext = Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]);
            try {
              return { result: plaintext.toString('hex'), shouldReEncrypt: false };
            } finally {
              plaintext.fill(0);
            }
          },
        };
  const custody = yield* makeNodeE2eeCustody({ directory, wrapper });
  // Release the initialization lock after the underlying custody has opened, retaining its Scope.
  yield* Effect.sync(() => mutex.exec('ROLLBACK'));
  return Object.freeze({
    protection,
    prepareDevice: () => custody.prepareDevice('machine'),
    retainDevice: custody.retainDevice,
    discardDevice: custody.discardDevice,
    createDevice: (genesis: Parameters<typeof custody.createDevice>[0]) =>
      custody.createDevice(genesis, 'machine'),
    openDevice: (genesis: Parameters<typeof custody.openDevice>[0]) =>
      custody.openDevice(genesis, 'machine'),
    installed: custody.installed,
    candidate: custody.candidate,
    stop: custody.stop,
    close: custody.close,
  });
});
