import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { fileLocksLegacy } from '@/utils/file-lock';
import { platformLayer } from '@/platform/process-options';
import { runDshPlugin } from './dsh-plugins';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import {
  dshProfileLockName,
  resolveDeepSeekHarnessProcessLaunch,
} from './deepseek-harness-runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native DSH plugin execution', () => {
  it('binds the Provider home, keeps caller cwd and environment, and returns the native exit code', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-plugin-'));
    roots.push(rootDir);
    const launch = await resolveDeepSeekHarnessProcessLaunch({
      rootDir,
      adapterPath: '/synthetic/acp.js',
      pluginArgs: ['add', './local-plugin'],
    });
    const argv = JSON.parse(Buffer.from(launch.env.LODY_DSH_NODE_ARGS, 'base64').toString());
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([
      'plugin',
      '--profile',
      'lody-acp',
      'add',
      './local-plugin',
    ]);
    const output = join(rootDir, 'result.json');
    const code = await fileLocksLegacy.runPromise(
      runDshPlugin(
        {
          ...launch,
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({home: process.env.DSH_HOME, cwd: process.cwd(), registry: process.env.npm_config_registry, node: process.env.LODY_DSH_NODE_EXECUTABLE, electron: process.env.ELECTRON_RUN_AS_NODE})); process.exitCode=7`,
            output,
          ],
        },
        rootDir,
        {
          PATH: dirname(process.execPath),
          DSH_HOME: '/wrong',
          npm_config_registry: 'https://synthetic.invalid',
          ELECTRON_RUN_AS_NODE: '1',
        }
      ).pipe(Effect.provide(platformLayer({})))
    );
    expect(code).toBe(7);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      home: rootDir,
      cwd: await realpath(rootDir),
      registry: 'https://synthetic.invalid',
      node: process.execPath,
    });
  });
  it('cancels the installer tree before making its Provider lock reusable', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'lody-dsh-cancel-'));
    roots.push(rootDir);
    const launch = await resolveDeepSeekHarnessProcessLaunch({
      rootDir,
      adapterPath: '/synthetic/acp.js',
      pluginArgs: ['add', 'synthetic'],
    });
    const table = new FakeProcessTable();
    const started = Promise.withResolvers<number>();
    const controller = new AbortController();
    const run = fileLocksLegacy.runPromise(
      runDshPlugin(launch, rootDir).pipe(
        Effect.provide(
          platformLayer({
            nodeProcess: {
              ...table.api,
              spawn: (command, args, options) => {
                const child = table.api.spawn(command, args, options);
                if (args[0] === '-p') {
                  queueMicrotask(() => {
                    table.childOf(child.pid!)!.stdout.write(
                      JSON.stringify({
                        execPath: process.execPath,
                        node: process.versions.node,
                        napi: process.versions.napi,
                      })
                    );
                    table.exitOnItsOwn(child.pid!);
                  });
                } else {
                  started.resolve(child.pid ?? -1);
                }
                return child;
              },
            },
          })
        )
      ),
      { signal: controller.signal }
    );
    const outcome = run.then(
      () => 'completed',
      () => 'cancelled'
    );
    const leader = await started.promise;
    const descendant = table.addDescendant(leader);
    controller.abort();
    expect(await outcome).toBe('cancelled');
    expect(table.isAlive(leader)).toBe(false);
    expect(table.isAlive(descendant)).toBe(false);
    expect(
      await fileLocksLegacy.withLock(dshProfileLockName(rootDir), async () => 'reusable', {
        locksDir: join(rootDir, 'lody-locks'),
      })
    ).toBe('reusable');
  });
});
