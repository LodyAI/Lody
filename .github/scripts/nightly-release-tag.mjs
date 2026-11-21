import assert from 'node:assert/strict';

// Called only after every publisher succeeds, with the admitted SHA and reserved version.
export async function tagNightlyRelease({ github, owner, repo, version, sha }) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0-nightly\.(0|[1-9]\d*)$/u);
  assert.match(sha, /^[a-f0-9]{40}$/u);
  const tag = `nightly-${version}`;
  const ref = `tags/${tag}`;
  const read = async () => {
    try {
      return (await github.rest.git.getRef({ owner, repo, ref })).data;
    } catch (error) {
      if (error.status === 404) return undefined;
      throw error;
    }
  };
  const verify = (existing) => {
    assert.equal(existing?.ref, `refs/${ref}`, 'Unexpected Nightly tag reference');
    assert.equal(existing.object.type, 'commit', 'Nightly tag must point directly to a commit');
    assert.equal(existing.object.sha, sha, `Refusing to overwrite ${tag}: commit differs`);
  };
  const existing = await read();
  if (existing) {
    verify(existing);
    return tag;
  }
  let created;
  try {
    // Verify the created ref from the write response: GitHub can briefly answer 404
    // when the new tag is read back immediately.
    created = (await github.rest.git.createRef({ owner, repo, ref: `refs/${ref}`, sha })).data;
  } catch (error) {
    // Another writer may have created the ref. Accept only the exact same target.
    if (error.status !== 409 && error.status !== 422) throw error;
    const raced = await read();
    if (!raced) throw error;
    verify(raced);
    return tag;
  }
  verify(created);
  return tag;
}
