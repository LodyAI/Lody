import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const runner = path.join(root, 'scripts/effect-lint/run.mjs');
const effect = path.dirname(
  require.resolve('effect/package.json', { paths: [path.join(root, 'apps/cli')] })
);

function lint(source, args = []) {
  const directory = mkdtempSync(path.join(tmpdir(), 'lody-effect-lint-test-'));
  try {
    mkdirSync(path.join(directory, 'node_modules'));
    symlinkSync(effect, path.join(directory, 'node_modules/effect'), 'junction');
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    writeFileSync(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
        },
        include: ['fixture.ts'],
      })
    );
    writeFileSync(path.join(directory, 'fixture.ts'), source);
    const result = spawnSync(
      process.execPath,
      [runner, '--threads', '1', '--format', 'json', ...args, path.join(directory, 'fixture.ts')],
      {
        cwd: directory,
        encoding: 'utf8',
      }
    );
    assert.ifError(result.error);
    assert.ok(result.status === 0 || result.status === 1, result.stderr + result.stdout);
    assert.ok(result.stdout.trimStart().startsWith('{'), result.stderr + result.stdout);
    return { status: result.status, diagnostics: JSON.parse(result.stdout).diagnostics };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const mistakes = `
import { Effect } from "effect";
Effect.succeed(1);
export const nested = Effect.gen(function* () {
  return Effect.runSync(Effect.succeed(1));
});
export const bare = Effect.gen(function* () {
  yield Effect.succeed(1);
});
export const returned = Effect.gen(function* () {
  return Effect.succeed(1);
});
export const lazy = Effect.sync(() => Promise.resolve(1));
export const wrapped = (n: number) => Effect.gen(function* () {
  return yield* Effect.succeed(n);
});
`;

test('official and community rules report mistakes with visible warning severity', () => {
  const result = lint(mistakes);
  assert.equal(result.status, 0);
  assert.deepEqual(
    new Set(result.diagnostics.map((diagnostic) => diagnostic.code)),
    new Set([
      'effecttsgo(floating-effect)',
      'effecttsgo(run-effect-inside-effect)',
      'effecttsgo(missing-star-in-yield-effect-gen)',
      'effecttsgo(return-effect-in-gen)',
      'effecttsgo(lazy-promise-in-effect-sync)',
      'effect(prefer-effect-fn)',
    ])
  );
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning'));
});

test('warnings can fail a strict invocation', () => {
  const result = lint(mistakes, ['--deny-warnings']);
  assert.equal(result.status, 1);
  assert.ok(result.diagnostics.length > 0);
});

test('composition, entry runners, and ordinary code remain valid', () => {
  const result = lint(`
import { Effect } from "effect";
export const program = Effect.fn("program")(function* (n: number) {
  return yield* Effect.succeed(n);
});
export const entry = Effect.runSync(program(1));
export const asyncProgram = Effect.tryPromise({ try: () => Promise.resolve(1), catch: () => "failed" as const });
export const pure = (n: number) => n + 1;
export const external = async () => JSON.parse("{}");
`);
  assert.equal(result.status, 0);
  assert.deepEqual(result.diagnostics, []);
});
