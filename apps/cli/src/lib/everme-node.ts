import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import * as tar from 'tar';
import { runCommandTextLegacy } from '@lody/shared/node/process';
import { getLoginShellEnvLegacy } from '@/agent/login-shell-env';
import { extractAbortableZip } from '@/agent/abortable-zip';
import { toShared } from '@/platform/process-options';
import { getLogger } from '@/utils/logger';

/**
 * EverMe needs a working npm twice over: EverCLI is distributed through it, and
 * `evercli plugin install` fetches each agent's plugin with `npm install -g`,
 * whose hooks then run on node. A machine with no npm, or one whose global
 * folder belongs to root, can take neither step, so Lody brings a Node.js of
 * the user's own into their home folder and puts it on PATH.
 *
 * Pinned to the release Lody itself requires, so every machine runs the build
 * that was checked rather than whatever is newest that day.
 */
export const EVERME_NODE_VERSION = 'v22.23.4';
/**
 * SHA-256 of each archive of that release, copied from nodejs.org's own
 * SHASUMS256.txt. Kept here rather than fetched beside the archive: a source
 * that serves both can change both, so a list read from it only shows the
 * download arrived whole, never that it is the build Node.js published. A
 * mirror may still serve the bytes; it no longer gets to say what they are.
 * Changing the version above means replacing every entry.
 */
const EVERME_NODE_SHA256: Readonly<Record<string, string>> = {
  'node-v22.23.4-darwin-arm64.tar.gz':
    'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428',
  'node-v22.23.4-darwin-x64.tar.gz':
    'efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819',
  'node-v22.23.4-linux-arm64.tar.gz':
    'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9',
  'node-v22.23.4-linux-x64.tar.gz':
    'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',
  'node-v22.23.4-win-arm64.zip': 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111',
  'node-v22.23.4-win-x64.zip': 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20',
};
const NODE_DIST = 'https://nodejs.org/dist';
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Written once into each shell profile; its presence means the line is there. */
const PROFILE_MARKER = '# Added by Lody: Node.js for EverMe';

export const evermeNodeDir = (home = os.homedir()): string => path.join(home, '.everme', 'node');
/** Node's own layout: `bin/` on Unix, the root on Windows. Global bins land there too. */
export const evermeNodeBinDir = (platform = process.platform, home = os.homedir()): string =>
  platform === 'win32' ? evermeNodeDir(home) : path.join(evermeNodeDir(home), 'bin');

const pathKey = (env: Record<string, string | undefined>): string =>
  process.platform === 'win32'
    ? (Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path')
    : 'PATH';

/**
 * The environment for commands Lody runs on EverMe's behalf, once Lody's Node
 * exists. Its npm comes first and owns its prefix, so the global installs Lody
 * and EverCLI make both land in a folder the user can write, and EverCLI finds
 * the plugins where it put them. A machine that never needed it is untouched.
 */
export const withEverMeNode = (
  env: Record<string, string | undefined>
): Record<string, string | undefined> => {
  const bin = evermeNodeBinDir();
  if (!existsSync(bin)) return env;
  const key = pathKey(env);
  return {
    ...env,
    [key]: [bin, env[key]].filter(Boolean).join(path.delimiter),
    npm_config_prefix: evermeNodeDir(),
  };
};

const nodeBuild = (): { name: string; archive: string } | undefined => {
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined;
  if (!arch) return undefined;
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const name = `node-${EVERME_NODE_VERSION}-${process.platform}-${arch}`;
    return { name, archive: `${name}.tar.gz` };
  }
  if (process.platform === 'win32') {
    const name = `node-${EVERME_NODE_VERSION}-win-${arch}`;
    return { name, archive: `${name}.zip` };
  }
  return undefined;
};

const nodeRuns = async (): Promise<boolean> => {
  const executable = path.join(
    evermeNodeBinDir(),
    process.platform === 'win32' ? 'node.exe' : 'node'
  );
  if (!existsSync(executable)) return false;
  try {
    const result = await runCommandTextLegacy(
      { command: executable, args: ['--version'], check: 'none', timeout: 10_000 },
      toShared()
    );
    return result.code === 0 && result.stdout.trim().startsWith('v');
  } catch {
    return false;
  }
};

const fetchOk = async (url: string, signal: AbortSignal): Promise<Response> => {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`${url} answered HTTP ${response.status}`);
  return response;
};

/**
 * Where the builds come from: nodejs.org, after any mirror the machine already
 * points nvm or node-gyp at (`NODEJS_ORG_MIRROR`, `NVM_NODEJS_ORG_MIRROR`), so a
 * user behind a slow route keeps the one they chose. Whichever answers, the
 * archive has to match the checksum pinned above.
 */
const nodeDistSources = async (): Promise<string[]> => {
  const env = { ...(await getLoginShellEnvLegacy().catch(() => null)), ...process.env };
  const mirrors = [env.NODEJS_ORG_MIRROR, env.NVM_NODEJS_ORG_MIRROR]
    .map((value) => value?.trim().replace(/\/+$/u, ''))
    .filter((value): value is string => !!value && /^https?:\/\//u.test(value));
  return [...new Set([...mirrors, NODE_DIST])];
};

const sha256 = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

/** Downloads, verifies and unpacks the pinned build into `~/.everme/node`. */
const downloadNode = async (build: { name: string; archive: string }): Promise<void> => {
  const root = path.dirname(evermeNodeDir());
  await mkdir(root, { recursive: true });
  const expected = EVERME_NODE_SHA256[build.archive];
  if (!expected) throw new Error(`No pinned checksum for ${build.archive}`);
  const scratch = await mkdtemp(path.join(root, '.node-'));
  try {
    const archive = path.join(scratch, build.archive);
    let downloaded = false;
    let lastError: unknown;
    for (const mirror of await nodeDistSources()) {
      try {
        const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
        const base = `${mirror}/${EVERME_NODE_VERSION}`;
        const response = await fetchOk(`${base}/${build.archive}`, signal);
        await pipeline(
          Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
          createWriteStream(archive),
          { signal }
        );
        if ((await sha256(archive)) !== expected)
          throw new Error(`${build.archive} from ${mirror} does not match the pinned checksum`);
        downloaded = true;
        break;
      } catch (error) {
        lastError = error;
        await rm(archive, { force: true });
      }
    }
    if (!downloaded) throw lastError ?? new Error('Node.js could not be downloaded');
    const unpack = path.join(scratch, 'unpack');
    await mkdir(unpack);
    if (build.archive.endsWith('.zip'))
      await extractAbortableZip(archive, unpack, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    else await pipeline(createReadStream(archive), tar.x({ cwd: unpack }));
    // Only a build that did not run reaches here, so the folder holds nothing
    // worth keeping; its global packages are reinstalled on the next attempt.
    await rm(evermeNodeDir(), { recursive: true, force: true });
    await rename(path.join(unpack, build.name), evermeNodeDir());
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/** The profiles a login or interactive shell of this user reads, by shell. */
const profileTargets = (home: string): { file: string; line: string }[] => {
  let shell = process.env.SHELL ?? '';
  try {
    shell = os.userInfo().shell ?? shell;
  } catch {
    // No passwd entry; the environment's guess stands.
  }
  const posix = `export PATH="$PATH:$HOME/.everme/node/bin"`;
  switch (path.basename(shell)) {
    case 'zsh':
      // Read by every zsh, login or not, before macOS's path_helper runs; an
      // entry appended here survives its reordering.
      return [{ file: path.join(home, '.zshenv'), line: posix }];
    case 'bash': {
      const login = existsSync(path.join(home, '.bash_profile')) ? '.bash_profile' : '.profile';
      return [
        { file: path.join(home, login), line: posix },
        { file: path.join(home, '.bashrc'), line: posix },
      ];
    }
    case 'fish':
      return [
        {
          file: path.join(home, '.config', 'fish', 'conf.d', 'everme-node.fish'),
          line: 'contains $HOME/.everme/node/bin $PATH; or set -gx PATH $PATH $HOME/.everme/node/bin',
        },
      ];
    default:
      return [{ file: path.join(home, '.profile'), line: posix }];
  }
};

/**
 * Appended, never prepended: a Node the user already has keeps winning in
 * their own terminal, and this one is only found where nothing else is. Lody's
 * own commands put it first themselves (`withEverMeNode`).
 */
const persistOnPath = async (): Promise<void> => {
  const home = os.homedir();
  if (process.platform === 'win32') {
    // The user's own Path, kept as REG_EXPAND_SZ so entries such as
    // %USERPROFILE% stay unexpanded, then announced so new processes see it.
    const script = [
      '$dir = $env:LODY_EVERME_NODE_DIR',
      "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
      "$current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
      "if (-not (($current -split ';') -contains $dir)) {",
      '  $next = if ($current) { "$current;$dir" } else { $dir }',
      "  $key.SetValue('Path', $next, [Microsoft.Win32.RegistryValueKind]::ExpandString)",
      '}',
      '$key.Close()',
      'Add-Type -Namespace Lody -Name Env -MemberDefinition \'[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);\'',
      '$out = [System.UIntPtr]::Zero',
      "[Lody.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out) | Out-Null",
    ].join('\n');
    const result = await runCommandTextLegacy(
      {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', script],
        check: 'none',
        env: { ...process.env, LODY_EVERME_NODE_DIR: evermeNodeBinDir() },
        timeout: 30_000,
      },
      toShared()
    );
    if (result.code !== 0)
      throw new Error(`Could not add Node.js to the user Path: ${result.stderr}`);
    return;
  }
  for (const { file, line } of profileTargets(home)) {
    const current = await readFile(file, 'utf8').catch(() => '');
    if (current.includes('.everme/node/bin')) continue;
    await mkdir(path.dirname(file), { recursive: true });
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${separator}\n${PROFILE_MARKER}\n${line}\n`);
  }
};

/** Puts the build on this daemon's own PATH, for the agents it starts from now on. */
const addToProcessPath = (): void => {
  const key = pathKey(process.env);
  const bin = evermeNodeBinDir();
  const parts = (process.env[key] ?? '').split(path.delimiter).filter(Boolean);
  if (!parts.includes(bin)) process.env[key] = [...parts, bin].join(path.delimiter);
};

/**
 * Makes sure Lody's Node.js is installed, runs, and is on PATH: for Lody's own
 * commands at once, for the agents this daemon starts next, and for every new
 * shell. Throws only when no working Node.js could be put in place; a profile
 * that could not be written is logged, since Lody's own commands still work.
 */
export async function ensureEverMeNode(): Promise<void> {
  if (!(await nodeRuns())) {
    const build = nodeBuild();
    if (!build) throw new Error(`No Node.js build for ${process.platform}-${process.arch}`);
    await downloadNode(build);
    if (!(await nodeRuns())) throw new Error('The downloaded Node.js does not run on this machine');
  }
  addToProcessPath();
  await persistOnPath().catch((error: unknown) => {
    getLogger().warn(
      `Could not add Lody's Node.js to PATH for new shells: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}
