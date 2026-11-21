import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Releases are created by Release Please; never replace their notes, tag or existing bytes.
export async function attachReleaseAssets({ github, repo, version, assets }) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-next\.\d+)?$/u);
  const release = (
    await github.rest.repos.getReleaseByTag({ ...repo, tag: `lody-electron-v${version}` })
  ).data;
  assert.equal(release.draft, false);
  const existing = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: release.id,
    per_page: 100,
  });
  const names = new Set();
  for (const asset of assets) {
    assert.ok(!names.has(asset.name), 'Duplicate installer name');
    names.add(asset.name);
    assert.ok(
      asset.name.startsWith(`Lody-${version}-`) &&
        /\.(?:dmg|exe|AppImage|deb|snap|zip)$/u.test(asset.name)
    );
    const data = await asset.read();
    const matches = existing.filter((value) => value.name === asset.name);
    assert.ok(matches.length <= 1, 'Ambiguous existing installer');
    if (matches.length) {
      const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
      assert.equal(
        matches[0].digest,
        digest,
        'Existing installer has different or unverifiable bytes'
      );
      assert.equal(matches[0].size, data.length);
      continue;
    }
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name: asset.name,
      data,
      headers: { 'content-type': 'application/octet-stream', 'content-length': data.length },
    });
  }
  assert.ok(names.size > 0, 'No installers to attach');
}
