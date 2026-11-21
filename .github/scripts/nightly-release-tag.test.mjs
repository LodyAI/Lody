import assert from 'node:assert/strict';
import test from 'node:test';
import { tagNightlyRelease } from './nightly-release-tag.mjs';

const sha = 'a'.repeat(40);
const tag = 'nightly-0.107.0-nightly.2';
const ref = `refs/tags/${tag}`;
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function fixture(existing) {
  const state = { existing, writes: [] };
  const github = {
    rest: {
      git: {
        async getRef(args) {
          assert.deepEqual(args, { owner: 'loro-dev', repo: 'lody', ref: `tags/${tag}` });
          if (state.readError) throw state.readError;
          if (!state.existing || state.readLag) throw httpError(404);
          return { data: state.existing };
        },
        async createRef(args) {
          state.writes.push(args);
          state.existing = { ref, object: { type: 'commit', sha } };
          if (state.raceSha) state.existing.object.sha = state.raceSha;
          if (state.createError) throw state.createError;
          return { data: state.existing };
        },
      },
    },
  };
  return {
    state,
    run: (overrides = {}) =>
      tagNightlyRelease({
        github,
        owner: 'loro-dev',
        repo: 'lody',
        version: '0.107.0-nightly.2',
        sha,
        ...overrides,
      }),
  };
}

await test('creates the full-version tag at the exact admitted commit; retry is read-only', async () => {
  const { state, run } = fixture();
  assert.equal(await run(), tag);
  assert.deepEqual(state.writes, [{ owner: 'loro-dev', repo: 'lody', ref, sha }]);
  assert.equal(await run(), tag);
  assert.equal(state.writes.length, 1);
});

await test('a successful creation is accepted while the new tag is not yet readable', async () => {
  // GitHub can answer 404 for a ref it has just created.
  const { state, run } = fixture();
  state.readLag = true;
  assert.equal(await run(), tag);
  assert.equal(state.writes.length, 1);
});

for (const object of [
  { type: 'commit', sha: 'b'.repeat(40) },
  { type: 'tag', sha },
]) {
  await test(`rejects existing conflicting target ${object.type} without writing`, async () => {
    const { state, run } = fixture({ ref, object });
    await assert.rejects(run());
    assert.equal(state.writes.length, 0);
  });
}

for (const status of [409, 422]) {
  await test(`creation race ${status} accepts only the same commit`, async () => {
    const { state, run } = fixture();
    state.createError = httpError(status);
    assert.equal(await run(), tag);
    const conflict = fixture();
    conflict.state.createError = httpError(status);
    conflict.state.raceSha = 'b'.repeat(40);
    await assert.rejects(conflict.run(), /Refusing to overwrite/u);
  });
}

for (const status of [403, 500]) {
  await test(`read failure ${status} cannot authorize a write`, async () => {
    const { state, run } = fixture();
    state.readError = httpError(status);
    await assert.rejects(run(), { status });
    assert.equal(state.writes.length, 0);
  });
  await test(`create failure ${status} is surfaced`, async () => {
    const { state, run } = fixture();
    state.createError = httpError(status);
    await assert.rejects(run(), { status });
  });
}

await test('rejects missing or malformed version and commit inputs before API writes', async () => {
  for (const override of [
    { version: '' },
    { version: '0.107.2' },
    { version: '0.107.0-nightly.02' },
    { version: '0.107.0-nightly.2\n' },
    { sha: 'main' },
    { sha: '' },
  ]) {
    const { state, run } = fixture();
    await assert.rejects(run(override));
    assert.equal(state.writes.length, 0);
  }
});
