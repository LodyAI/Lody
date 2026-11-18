import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import {
  nodeProcessLive,
  processLayer,
  runCommandOk,
  type NodeProcessApi,
} from '@lody/shared/node/process';
import { nativeMachineCatalogCandidateDigest } from '@lody/shared/native-machine-catalog-verification';
import type { AgentConfigMeta, MachineCatalogBinding } from '@lody/shared';
import {
  NativeMachineCatalogVerifierLegacy,
  verifyNativeMachineCatalogCandidate,
} from '../../../../electron/src/main/services/native-machine-catalog-verifier';

const require = createRequire(import.meta.url);
const roots = new Set<string>();
const owners = new Set<NativeMachineCatalogVerifierLegacy>();
let compiled: string;
const binding = {
  accountId: 'local:verification',
  workspaceId: 'lw_verification',
  machineId: 'verification-machine',
} as MachineCatalogBinding;
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const gone = (pid: number) => {
  expect(() => process.kill(pid, 0)).toThrow();
};
beforeAll(async () => {
  compiled = resolve(
    import.meta.dirname,
    '../../..',
    'node_modules/.cache',
    `mf-verify-${randomUUID()}`
  );
  roots.add(compiled);
  await mkdir(compiled, { recursive: true });
  await build({
    entryPoints: [join(import.meta.dirname, 'native-machine-catalog-verify-entry.ts')],
    outfile: join(compiled, 'native-machine-catalog-verify.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url);",
    },
    plugins: [
      {
        name: 'real-cli-workspace-dependencies',
        setup(builder) {
          builder.onResolve({ filter: /^@lody\/shared(?:\/|$)/ }, (args) => {
            const file = resolve(
              import.meta.dirname,
              '../../../../../packages/shared/src',
              args.path === '@lody/shared' ? 'index' : args.path.slice('@lody/shared/'.length)
            );
            return { path: existsSync(file + '.ts') ? file + '.ts' : join(file, 'index.ts') };
          });
          builder.onResolve(
            {
              filter:
                /^(?:@loro-dev\/flock-wasm|@loro-dev\/roost-node|loro-crdt|better-sqlite3|@lydell\/node-pty|@napi-rs\/keyring)$/,
            },
            (args) => ({ path: require.resolve(args.path), external: true })
          );
        },
      },
    ],
  });
  await writeFile(
    join(compiled, 'provider.mjs'),
    `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const [mode, events]=process.argv.slice(2);
const log = event => appendFileSync(events,JSON.stringify({event,pid:process.pid,parent:process.ppid,cwd:process.cwd()})+'\\n');
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='initialize') {
    log('initialize'); process.stderr.write(process.env.SYNTHETIC_PRIVATE_ENV+'\\n');
    reply(request.id,{protocolVersion:request.params.protocolVersion,agentCapabilities:{},authMethods:[],agentInfo:{name:'Synthetic probe',version:'1'}});
  } else if(request.method==='session/new') {
    log('session');
    if(mode==='hang') return;
    if(mode==='fail') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:process.env.SYNTHETIC_PRIVATE_ENV}})+'\\n');return;}
    reply(request.id,{sessionId:'synthetic-probe-session',...(mode==='empty'?{configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'',options:[]}]}:{})});
  } else if(request.id!==undefined) reply(request.id,{});
});
`
  );
});
afterEach(async () => {
  const settled = await Promise.allSettled([...owners].map((owner) => owner.close()));
  if (settled.some((result) => result.status === 'rejected'))
    throw new Error('Verification test retained an unconfirmed process owner');
  owners.clear();
  for (const root of [...roots])
    if (root !== compiled) {
      await rm(root, { recursive: true, force: true });
      roots.delete(root);
    }
});
afterAll(async () => {
  await rm(compiled, { recursive: true, force: true });
});
async function fixture(mode = 'success') {
  const dataRoot = await mkdtemp(join(tmpdir(), 'lody-mf-candidate-'));
  roots.add(dataRoot);
  const events = join(dataRoot, 'events.ndjson');
  await writeFile(events, '');
  await writeFile(join(dataRoot, 'machine-id'), binding.machineId);
  const candidate: AgentConfigMeta = {
    id: 'synthetic-candidate' as never,
    machineId: binding.machineId,
    name: 'Synthetic candidate',
    cliType: 'custom',
    agentType: 'custom',
    customAcp: { command: process.execPath, args: [join(compiled, 'provider.mjs'), mode, events] },
    env: { SYNTHETIC_PRIVATE_ENV: 'SYNTHETIC_CANDIDATE_ENV_SECRET' },
    prompt: 'SYNTHETIC_CANDIDATE_PROMPT_SECRET',
  };
  const children: ChildProcess[] = [];
  const exited = deferred<void>();
  const nodeProcess: NodeProcessApi = {
    ...nodeProcessLive,
    spawn(command, args, options) {
      const child = nodeProcessLive.spawn(command, args, options);
      children.push(child);
      child.once('exit', () => exited.resolve());
      return child;
    },
  };
  const owner = new NativeMachineCatalogVerifierLegacy(
    {
      dataRoot,
      environment: async () => ({ PATH: process.env.PATH, HOME: process.env.HOME }),
      launch: () => ({
        executable: process.execPath,
        entry: join(compiled, 'native-machine-catalog-verify.js'),
      }),
    },
    { nodeProcess }
  );
  owners.add(owner);
  const waitSession = () =>
    new Promise<void>((yes, no) => {
      const watcher = watch(events, () => {
        void check();
      });
      watcher.once('error', no);
      const check = async () => {
        try {
          if ((await readFile(events, 'utf8')).includes('"event":"session"')) {
            watcher.close();
            yes();
          }
        } catch (error) {
          watcher.close();
          no(error);
        }
      };
      void check();
    });
  return {
    dataRoot,
    events,
    candidate,
    children,
    exited,
    nodeProcess,
    owner,
    waitSession,
    request: () => ({ binding, generation: 'generation-verification', candidate }),
    async evidence() {
      return (await readFile(events, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) => JSON.parse(line) as { event: string; pid: number; parent: number; cwd: string }
        );
    },
  };
}
it('verifies a real ACP candidate without catalog persistence or credential output and closes the contained process before accepting the receipt', async () => {
  const f = await fixture();
  expect(await f.owner.verify(f.request())).toBe(true);
  const evidence = await f.evidence();
  expect(evidence.map((event) => event.event)).toEqual(['initialize', 'session']);
  expect(evidence[0]!.parent).toBe(f.children[0]!.pid);
  gone(evidence[0]!.pid);
  gone(f.children[0]!.pid!);
  expect(evidence[0]!.cwd).toContain('lody-acp-capabilities-');
  await expect(readdir(evidence[0]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(f.dataRoot)).sort()).toEqual(['events.ndjson', 'machine-id']);
  expect(await readFile(join(f.dataRoot, 'machine-id'), 'utf8')).toBe(binding.machineId);
  await f.owner.close();
});
it('rejects provider errors and empty advertised model catalogs without returning candidate secrets or publishing rows', async () => {
  for (const mode of ['fail', 'empty']) {
    const f = await fixture(mode);
    expect(await f.owner.verify(f.request()), mode).toBe(false);
    for (const event of await f.evidence()) gone(event.pid);
    gone(f.children[0]!.pid!);
    await f.owner.close();
  }
});
it('cancels only its owned live candidate probe, awaits process exit and leaves an independent verification available', async () => {
  const blocked = await fixture('hang'),
    sibling = await fixture();
  const abort = new AbortController();
  const pending = blocked.owner.verify({ ...blocked.request(), signal: abort.signal });
  void pending.catch(() => {});
  await Promise.race([
    blocked.waitSession(),
    pending.then(() => {
      throw new Error('Probe completed before the session barrier');
    }),
  ]);
  expect(await sibling.owner.verify(sibling.request())).toBe(true);
  abort.abort();
  await expect(pending).rejects.toThrow('verification failed');
  for (const event of await blocked.evidence()) gone(event.pid);
  gone(blocked.children[0]!.pid!);
  await blocked.owner.close();
  await sibling.owner.close();
});
it('rejects a helper receipt for another generation even when the child exits successfully', async () => {
  const f = await fixture();
  const tampered = join(f.dataRoot, 'wrong-receipt.mjs');
  await writeFile(
    tampered,
    `let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);process.stdout.write(JSON.stringify({version:1,requestId:input.requestId,binding:input.binding,expectedGeneration:'wrong',candidateSha256:input.candidateSha256,configId:input.candidate.id,verified:true}));`
  );
  const owner = new NativeMachineCatalogVerifierLegacy({
    dataRoot: f.dataRoot,
    environment: async () => ({ PATH: process.env.PATH, HOME: process.env.HOME }),
    launch: () => ({ executable: process.execPath, entry: tampered }),
  });
  owners.add(owner);
  await expect(owner.verify(f.request())).rejects.toThrow('verification failed');
  expect(await f.evidence()).toEqual([]);
  await owner.close();
});
effectIt.effect(
  'uses the injected deadline to terminate an actual held probe and never returns a verification receipt after timeout',
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(() => fixture('hang'));
      const fiber = yield* Effect.forkChild(
        verifyNativeMachineCatalogCandidate(
          {
            dataRoot: f.dataRoot,
            environment: async () => ({ PATH: process.env.PATH, HOME: process.env.HOME }),
            launch: () => ({
              executable: process.execPath,
              entry: join(compiled, 'native-machine-catalog-verify.js'),
            }),
            helperTimeoutMs: 180000,
          },
          f.request()
        ).pipe(Effect.provide(processLayer({ nodeProcess: f.nodeProcess })), Effect.exit)
      );
      yield* Effect.promise(() => f.waitSession());
      yield* TestClock.adjust(180000);
      yield* Effect.promise(() => f.exited.promise);
      yield* TestClock.adjust(4000);
      const result = yield* Fiber.join(fiber);
      expect(Exit.isFailure(result)).toBe(true);
      for (const event of yield* Effect.promise(() => f.evidence())) gone(event.pid);
      gone(f.children[0]!.pid!);
    })
);
it('rejects a mismatched candidate digest at the flat helper boundary with fixed diagnostics and no probe', async () => {
  const f = await fixture();
  const input = {
    version: 1,
    requestId: randomUUID(),
    binding,
    expectedGeneration: 'generation-verification',
    candidateSha256: nativeMachineCatalogCandidateDigest({ ...f.candidate, name: 'other' }),
    candidate: f.candidate,
  };
  const result = await Effect.runPromiseExit(
    runCommandOk({
      command: process.execPath,
      args: [join(compiled, 'native-machine-catalog-verify.js')],
      env: { ...process.env, LODY_PLATFORM: 'local', LODY_DATA_DIR: f.dataRoot },
      input: JSON.stringify(input),
      timeout: 30000,
      maxOutputBytes: 8192,
    }).pipe(Effect.provide(processLayer({})))
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_CANDIDATE_ENV_SECRET');
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_CANDIDATE_PROMPT_SECRET');
  expect(await f.evidence()).toEqual([]);
});

it('retains a denied helper-group release, fences that provider and permits an independent candidate until the exact process owner can close', async () => {
  const blocked = await fixture('hang');
  const alternate = await fixture();
  let denied = true;
  Reflect.set(blocked.nodeProcess, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => {
    if (denied && signal !== 0 && pid === -blocked.children[0]?.pid!) {
      const error = new Error('Synthetic owned process release denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return nodeProcessLive.kill(pid, signal);
  }) satisfies NodeProcessApi['kill']);
  try {
    const abort = new AbortController();
    const pending = blocked.owner.verify({ ...blocked.request(), signal: abort.signal });
    void pending.catch(() => {});
    await Promise.race([
      blocked.waitSession(),
      pending.then(() => {
        throw new Error('Probe completed before its barrier');
      }),
    ]);
    const oldProvider = (await blocked.evidence())[0]!.pid;
    const oldHelper = blocked.children[0]!.pid!;
    abort.abort();
    await expect(pending).rejects.toThrow('verification failed');
    expect(() => process.kill(oldHelper, 0)).not.toThrow();
    expect(() => process.kill(oldProvider, 0)).not.toThrow();
    await expect(blocked.owner.verify(blocked.request())).rejects.toThrow('cleanup is unconfirmed');
    expect(
      await blocked.owner.verify({
        ...alternate.request(),
        candidate: { ...alternate.candidate, id: 'another-provider' as never },
      })
    ).toBe(true);
    const independent = await alternate.evidence();
    gone(independent[0]!.pid);
    expect(() => process.kill(oldHelper, 0)).not.toThrow();
    await expect(blocked.owner.close()).rejects.toThrow('verification failed');
    denied = false;
    await blocked.owner.retryCleanup();
    await blocked.owner.close();
    gone(oldProvider);
    gone(oldHelper);
  } finally {
    denied = false;
    await blocked.owner.close();
    await alternate.owner.close();
  }
});

it.skipIf(process.platform === 'win32')(
  'releases a background descendant left by a successful helper before returning a trusted verification',
  async () => {
    const f = await fixture();
    const entry = join(f.dataRoot, 'background-receipt.mjs');
    await writeFile(
      entry,
      `
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
let text='';for await(const chunk of process.stdin)text+=chunk;
const input=JSON.parse(text);
const child=spawn(process.execPath,['-e',"require('node:net').createServer().listen(0,'127.0.0.1',()=>process.stdout.write(String(process.pid)+'\\\\n'))"],{stdio:['ignore','pipe','ignore'],detached:false});
let buffer='';
child.stdout.on('data',chunk=>{
  buffer+=chunk.toString();if(!buffer.includes('\\n'))return;
  writeFileSync(join(process.env.LODY_DATA_DIR,'descendant.pid'),buffer.trim());
  child.stdout.destroy();child.unref();
  process.stdout.write(JSON.stringify({version:1,requestId:input.requestId,binding:input.binding,expectedGeneration:input.expectedGeneration,candidateSha256:input.candidateSha256,configId:input.candidate.id,verified:true}));
});
`
    );
    const owner = new NativeMachineCatalogVerifierLegacy({
      dataRoot: f.dataRoot,
      environment: async () => ({ PATH: process.env.PATH, HOME: process.env.HOME }),
      launch: () => ({ executable: process.execPath, entry }),
    });
    owners.add(owner);
    expect(await owner.verify(f.request())).toBe(true);
    const descendant = Number(await readFile(join(f.dataRoot, 'descendant.pid'), 'utf8'));
    expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
    gone(descendant);
    await owner.close();
  }
);
